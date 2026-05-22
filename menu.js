'use strict';

const { execSync } = require('child_process');
const blessed = require('blessed');
const { loadState, saveState, log } = require('./store');
const { getAnyAddressInfo, getBtcPrice, satToBtc, isExtendedKey, getTransaction } = require('./api');
const { deriveReceiveAddresses } = require('./xpub');
const AddressMonitor = require('./ws-monitor');

// Returns a map of address → portfolioIdx for all watchable addresses
function buildWatchMap(addressBook) {
  const map = {};
  addressBook.forEach((entry, idx) => {
    if (isExtendedKey(entry.address)) {
      try {
        // Derive 110 receive addresses — covers current wallet depth with headroom for new deposits
        deriveReceiveAddresses(entry.address, 110).forEach(addr => { map[addr] = idx; });
      } catch { /* ignore derivation errors */ }
    } else {
      map[entry.address] = idx;
    }
  });
  return map;
}

function shortAddr(addr) {
  if (addr.length <= 20) return addr;
  return addr.slice(0, 10) + '…' + addr.slice(-6);
}

const FETCH_CONCURRENCY = 4;
const FETCH_DELAY_MS = 300;

async function fetchAllBalances(addressBook, onUpdate, onProgress) {
  const results = [];
  for (let i = 0; i < addressBook.length; i += FETCH_CONCURRENCY) {
    const chunk = addressBook.slice(i, i + FETCH_CONCURRENCY);
    const chunkResults = await Promise.all(chunk.map(async (entry, j) => {
      const absIdx = i + j;
      try {
        if (entry.type === 'manual') {
          return { ...entry, balance: entry.balance || 0, txCount: null, error: null };
        }
        const info = await getAnyAddressInfo(entry.address, {
          gapLimit: entry.gapLimit,
          onProgress: onProgress ? (msg) => onProgress(absIdx, msg) : undefined,
        });
        const recv = info.chain_stats.funded_txo_sum + info.mempool_stats.funded_txo_sum;
        const spent = info.chain_stats.spent_txo_sum + info.mempool_stats.spent_txo_sum;
        const extra = info.lastFundedRecvIdx !== undefined ? { lastFundedRecvIdx: info.lastFundedRecvIdx } : {};
        return { ...entry, ...extra, balance: recv - spent, txCount: info.chain_stats.tx_count + info.mempool_stats.tx_count, error: null };
      } catch (err) {
        return { ...entry, balance: null, txCount: null, error: err.message };
      }
    }));
    results.push(...chunkResults);
    if (onUpdate) onUpdate(results);
    if (i + FETCH_CONCURRENCY < addressBook.length) {
      await new Promise(r => setTimeout(r, FETCH_DELAY_MS));
    }
  }
  return results;
}

function runMenu() {
  const state = loadState();

  const screen = blessed.screen({
    smartCSR: true,
    title: 'BTC Tracker',
    fullUnicode: true,
  });

  const logo = [
    ' {yellow-fg}██████╗ ████████╗  ██████╗{/yellow-fg}',
    ' {yellow-fg}██╔══██╗╚══██╔══╝ ██╔════╝{/yellow-fg}',
    ' {yellow-fg}██████╔╝   ██║    ██║{/yellow-fg}       {bold}T R A C K E R{/bold}',
    ' {yellow-fg}██╔══██╗   ██║    ██║{/yellow-fg}       {gray-fg}Portfolio Manager{/gray-fg}',
    ' {yellow-fg}██████╔╝   ██║    ╚██████╗{/yellow-fg}  {gray-fg}↑↓ navigate  [Enter] details  [a] add  [w] watch  [r] refresh  [q] quit{/gray-fg}',
    ' {yellow-fg}╚═════╝    ╚═╝     ╚═════╝{/yellow-fg}',
  ].join('\n');

  const header = blessed.box({
    top: 0, left: 0, width: '100%', height: 8,
    content: logo,
    tags: true,
    border: { type: 'line' },
    style: { fg: 'white', bg: 'black' },
  });

  const addrList = blessed.list({
    top: 8, left: 0, width: '100%', height: '100%-24',
    tags: true,
    border: { type: 'line' },
    label: ' Managed Addresses ',
    style: {
      border: { fg: 'cyan' },
      selected: { bg: 'blue', fg: 'white' },
      item: { fg: 'white' },
    },
    keys: true,
    vi: true,
    mouse: true,
    scrollable: true,
    scrollbar: { ch: '│', style: { fg: 'cyan' } },
  });

  const totalBox = blessed.box({
    bottom: 11, left: 0, width: '100%', height: 5,
    tags: true,
    border: { type: 'line' },
    label: ' Portfolio Total ',
    style: { border: { fg: 'green' } },
  });

  const activityBox = blessed.box({
    bottom: 3, left: 0, width: '100%', height: 8,
    tags: true,
    border: { type: 'line' },
    label: ' Recent Activity ',
    style: { border: { fg: 'gray' } },
    content: '  {gray-fg}No recent activity — watching for new transactions…{/gray-fg}',
  });

  const statusBar = blessed.box({
    bottom: 0, left: 0, width: '100%', height: 3,
    tags: true,
    border: { type: 'line' },
    style: { border: { fg: 'gray' } },
  });

  screen.append(header);
  screen.append(addrList);
  screen.append(activityBox);
  screen.append(totalBox);
  screen.append(statusBar);
  addrList.focus();

  let cachedData = state.addressBook.map(e => ({
    ...e,
    balance: e.type === 'manual'
      ? (e.balance || 0)
      : (e.cachedBalance !== undefined ? e.cachedBalance : null),
    txCount: e.type === 'manual' ? null : (e.cachedTxCount !== undefined ? e.cachedTxCount : null),
    error: null,
  }));
  let btcPrice = state.lastBtcPrice || null;
  let monitor = null;
  const refreshPending = new Set();
  let lastTx = null; // { txid, entryLabel, value, confirmed, detectedAt }

  async function checkMempoolOnConnect() {
    // Detect transactions that arrived before the WebSocket subscription opened.
    // For zpub: scan backwards from the watch-window ceiling (index 109) and stop
    // as soon as we reach lastFundedRecvIdx — anything above that boundary is new.
    if (lastTx) return;
    const { getAddressInfo } = require('./api');
    const axios = require('axios');

    for (let i = 0; i < state.addressBook.length; i++) {
      if (lastTx) return;
      const entry = state.addressBook[i];
      if (!entry || entry.type === 'manual') continue;

      if (isExtendedKey(entry.address)) {
        const boundary = entry.lastFundedRecvIdx !== undefined ? entry.lastFundedRecvIdx : -1;
        const addrs = deriveReceiveAddresses(entry.address, 110);

        for (let j = 109; j > boundary; j--) {
          if (lastTx) return;
          const address = addrs[j];
          try {
            const info = await getAddressInfo(address);
            const txCount = info.chain_stats.tx_count + info.mempool_stats.tx_count;
            if (txCount === 0) { await new Promise(r => setTimeout(r, 400)); continue; }

            // This index is above the boundary and has transactions — it's new
            const res = await axios.get(
              'https://mempool.space/api/address/' + address + '/txs',
              { timeout: 10000 }
            );
            const txs = res.data || [];
            if (txs.length > 0) {
              const tx = txs[0];
              const received = (tx.vout || []).reduce(
                (sum, o) => o.scriptpubkey_address === address ? sum + o.value : sum, 0
              );
              lastTx = {
                txid:       tx.txid,
                entryLabel: entry.label,
                value:      received,
                confirmed:  !!(tx.status && tx.status.confirmed),
                type:       'incoming',
                detectedAt: new Date().toLocaleTimeString(),
              };
              updateActivityBox();
              if (!refreshPending.has(i)) {
                refreshPending.add(i);
                refreshOne(i).finally(() => refreshPending.delete(i));
              }
            }
            return;
          } catch {}
          await new Promise(r => setTimeout(r, 400));
        }
      } else {
        // Regular address: compare live tx_count to cached
        try {
          const info = await getAddressInfo(entry.address);
          const liveTxCount = info.chain_stats.tx_count + info.mempool_stats.tx_count;
          if (liveTxCount > (entry.cachedTxCount || 0)) {
            const res = await axios.get(
              'https://mempool.space/api/address/' + entry.address + '/txs',
              { timeout: 10000 }
            );
            const txs = res.data || [];
            if (txs.length > 0 && !lastTx) {
              const tx = txs[0];
              const received = (tx.vout || []).reduce(
                (sum, o) => o.scriptpubkey_address === entry.address ? sum + o.value : sum, 0
              );
              lastTx = {
                txid:       tx.txid,
                entryLabel: entry.label,
                value:      received,
                confirmed:  !!(tx.status && tx.status.confirmed),
                type:       'incoming',
                detectedAt: new Date().toLocaleTimeString(),
              };
              updateActivityBox();
              if (!refreshPending.has(i)) {
                refreshPending.add(i);
                refreshOne(i).finally(() => refreshPending.delete(i));
              }
            }
          }
        } catch {}
      }
    }
  }

  function updateActivityBox() {
    if (!lastTx) return;
    const sign    = lastTx.value >= 0 ? '+' : '';
    const btcStr  = sign + satToBtc(Math.abs(lastTx.value)) + ' BTC';
    const typeTag = lastTx.type === 'removed'
      ? '{gray-fg}dropped from mempool{/gray-fg}'
      : lastTx.confirmed
        ? '{green-fg}✓ confirmed{/green-fg}'
        : '{yellow-fg}⏳ pending{/yellow-fg}';
    const usdStr  = btcPrice && lastTx.value !== 0
      ? '  {gray-fg}≈ $' + (Math.abs(lastTx.value) / 1e8 * btcPrice).toLocaleString('en-US', { maximumFractionDigits: 0 }) + '{/gray-fg}'
      : '';
    const shortTxid = lastTx.txid
      ? lastTx.txid.slice(0, 16) + '…' + lastTx.txid.slice(-8)
      : '—';
    activityBox.setContent(
      '  ' + typeTag + '  {bold}' + btcStr + '{/bold}' + usdStr +
      '  →  {cyan-fg}' + lastTx.entryLabel + '{/cyan-fg}' +
      '  {gray-fg}' + lastTx.detectedAt + '{/gray-fg}\n' +
      '  {gray-fg}txid: ' + shortTxid + '{/gray-fg}'
    );
    screen.render();
  }

  function startMonitor() {
    if (monitor) { monitor.stop(); monitor = null; }
    if (state.addressBook.length === 0) return;

    const watchMap = buildWatchMap(state.addressBook);
    if (Object.keys(watchMap).length === 0) return;

    monitor = new AddressMonitor(
      (address, txInfo) => {
        const idx = watchMap[address];
        if (idx === undefined) return;
        const entry = state.addressBook[idx];

        // Update activity panel immediately
        lastTx = {
          txid:       txInfo.txid,
          entryLabel: entry ? entry.label : shortAddr(address),
          value:      txInfo.value,
          confirmed:  txInfo.confirmed,
          type:       txInfo.type,
          detectedAt: new Date().toLocaleTimeString(),
        };
        updateActivityBox();

        // Refresh the balance for this entry
        if (!refreshPending.has(idx)) {
          refreshPending.add(idx);
          setStatus('New transaction — updating balance…', 'yellow');
          refreshOne(idx).finally(() => {
            refreshPending.delete(idx);
            setStatus('● live', 'green');
          });
        }
      },
      (status) => {
        if (status === 'connected') {
          setStatus('● live', 'green');
          // On first connect, silently check for transactions that arrived before
          // the WebSocket subscription was established (WebSocket only delivers new ones)
          setImmediate(() => checkMempoolOnConnect());
        } else if (status === 'connecting') {
          setStatus('◌ connecting…', 'gray');
        } else if (status === 'disconnected') {
          setStatus('○ reconnecting…', 'yellow');
        }
      },
      // onBlock: new block confirmed — re-check any pending tx
      async () => {
        if (!lastTx || lastTx.confirmed || lastTx.type === 'removed') return;
        try {
          const tx = await getTransaction(lastTx.txid);
          if (tx && tx.status && tx.status.confirmed) {
            lastTx.confirmed = true;
            updateActivityBox();
          }
        } catch { /* ignore — will resolve on next refresh */ }
      }
    );
    monitor.watch(Object.keys(watchMap));
    monitor.start();
  }

  function setStatus(msg, color) {
    color = color || 'gray';
    statusBar.setContent(' {' + color + '-fg}' + msg + '{/' + color + '-fg}');
    screen.render();
  }

  function updateDisplay() {
    if (state.addressBook.length === 0) {
      addrList.setItems([' {gray-fg}No addresses yet. Press [a] to add one.{/gray-fg}']);
      totalBox.setContent('\n  {gray-fg}Add addresses to start tracking your portfolio.{/gray-fg}');
      screen.render();
      return;
    }

    const items = cachedData.map((entry) => {
      const label = (entry.label || 'Unnamed').slice(0, 16).padEnd(16);
      const isManual = entry.type === 'manual';
      const addrShort = isManual ? '{gray-fg}manual{/gray-fg}'.padEnd(20) : shortAddr(entry.address).padEnd(20);

      if (!isManual && entry.error) {
        return ' {yellow-fg}' + label + '{/yellow-fg}  {gray-fg}' + shortAddr(entry.address).padEnd(20) + '{/gray-fg}  {red-fg}fetch error{/red-fg}';
      }
      if (!isManual && entry.balance === null) {
        const prog = entry.progressMsg || 'loading…';
        return ' {cyan-fg}' + label + '{/cyan-fg}  {gray-fg}' + shortAddr(entry.address).padEnd(20) + '{/gray-fg}  {gray-fg}' + prog + '{/gray-fg}';
      }

      const balStr = (satToBtc(entry.balance) + ' BTC').padEnd(16);
      const usdStr = btcPrice
        ? '{gray-fg} $' + (entry.balance / 1e8 * btcPrice).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) + '{/gray-fg}'
        : '';
      const txStr = (!isManual && entry.txCount !== null) ? '  {gray-fg}' + entry.txCount + ' txs{/gray-fg}' : '';
      return ' {cyan-fg}' + label + '{/cyan-fg}  ' + addrShort + '  {bold}{green-fg}' + balStr + '{/green-fg}{/bold}' + usdStr + txStr;
    });

    addrList.setItems(items);

    const valid = cachedData.filter(e => e.balance !== null && !e.error);
    const totalSat = valid.reduce((sum, e) => sum + e.balance, 0);
    const totalBtc = satToBtc(totalSat);
    const usdLine = btcPrice
      ? '  {gray-fg}≈ $' + (totalSat / 1e8 * btcPrice).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '  (1 BTC = $' + btcPrice.toLocaleString() + '){/gray-fg}'
      : '';
    const countNote = valid.length < state.addressBook.length
      ? '  {yellow-fg}(' + valid.length + '/' + state.addressBook.length + ' loaded){/yellow-fg}'
      : '  {gray-fg}' + state.addressBook.length + ' address' + (state.addressBook.length !== 1 ? 'es' : '') + '{/gray-fg}';

    totalBox.setContent(
      '  {bold}{green-fg}Total Balance:  ' + totalBtc + ' BTC{/green-fg}{/bold}' + usdLine + '\n' +
      '  {gray-fg}Updated: ' + new Date().toLocaleTimeString() + countNote + '{/gray-fg}'
    );

    screen.render();
  }

  async function refreshOne(idx) {
    const entry = state.addressBook[idx];
    if (!entry) return;
    cachedData[idx] = { ...entry, balance: null, txCount: null, error: null };
    updateDisplay();
    setStatus('Fetching balance for ' + (entry.label || shortAddr(entry.address)) + '…', 'cyan');
    try {
      const info = await getAnyAddressInfo(entry.address, {
        gapLimit: entry.gapLimit,
        onProgress: (msg) => {
          if (cachedData[idx]) { cachedData[idx].progressMsg = msg; updateDisplay(); }
        },
      });
      const recv = info.chain_stats.funded_txo_sum + info.mempool_stats.funded_txo_sum;
      const spent = info.chain_stats.spent_txo_sum + info.mempool_stats.spent_txo_sum;
      cachedData[idx] = { ...entry, balance: recv - spent, txCount: info.chain_stats.tx_count + info.mempool_stats.tx_count, error: null };
      state.addressBook[idx].cachedBalance = cachedData[idx].balance;
      state.addressBook[idx].cachedTxCount = cachedData[idx].txCount;
      if (info.lastFundedRecvIdx !== undefined) state.addressBook[idx].lastFundedRecvIdx = info.lastFundedRecvIdx;
      saveState(state);
      setStatus('Last refreshed: ' + new Date().toLocaleTimeString(), 'gray');
    } catch (err) {
      cachedData[idx] = { ...entry, balance: null, txCount: null, error: err.message };
      setStatus('Fetch error: ' + err.message, 'red');
    }
    updateDisplay();
  }

  async function refresh() {
    setStatus('Fetching balances…', 'cyan');
    cachedData = state.addressBook.map(e => ({ ...e, balance: null, txCount: null, error: null }));
    updateDisplay();

    try {
      const [newData, newPrice] = await Promise.all([
        fetchAllBalances(
          state.addressBook,
          (partial) => {
            cachedData = [
              ...partial,
              ...state.addressBook.slice(partial.length).map((e, j) => ({
                ...e,
                balance: null, txCount: null, error: null,
                progressMsg: cachedData[partial.length + j] && cachedData[partial.length + j].progressMsg,
              })),
            ];
            updateDisplay();
          },
          (idx, msg) => {
            if (cachedData[idx]) {
              cachedData[idx].progressMsg = msg;
              updateDisplay();
            }
          }
        ),
        getBtcPrice(),
      ]);
      cachedData = newData;
      if (newPrice) { btcPrice = newPrice; state.lastBtcPrice = newPrice; }
      newData.forEach((entry, i) => {
        if (state.addressBook[i] && entry.balance !== null && !entry.error) {
          state.addressBook[i].cachedBalance = entry.balance;
          state.addressBook[i].cachedTxCount = entry.txCount;
          if (entry.lastFundedRecvIdx !== undefined) {
            state.addressBook[i].lastFundedRecvIdx = entry.lastFundedRecvIdx;
          }
        }
      });
      state.lastFetched = Date.now();
      saveState(state);
      setStatus('Last refreshed: ' + new Date().toLocaleTimeString(), 'gray');
      startMonitor();
    } catch (err) {
      setStatus('Refresh error: ' + err.message, 'red');
    }
    updateDisplay();
  }

  // ── Submenu actions ──────────────────────────────────────────────────────

  function doWatch(idx) {
    const entry = state.addressBook[idx];
    screen.destroy();
    const { watchAddress } = require('./watcher');
    watchAddress(entry.address, { interval: 60, onExit: runMenu });
  }

  function doEditLabel(idx) {
    const entry = state.addressBook[idx];
    const prompt = blessed.prompt({
      parent: screen,
      top: 'center', left: 'center',
      height: 'shrink', width: 60,
      border: 'line',
      label: ' Edit Label ',
      tags: true,
      style: { border: { fg: 'yellow' } },
    });
    prompt.input('New label:', entry.label, (_err, value) => {
      if (value && value.trim()) {
        state.addressBook[idx].label = value.trim();
        if (cachedData[idx]) cachedData[idx].label = value.trim();
        saveState(state);
        log('Label updated for ' + entry.address + ': ' + value.trim());
        setStatus('Label updated: ' + value.trim(), 'green');
        updateDisplay();
      }
      addrList.focus();
    });
  }

  function doEditNotes(idx) {
    const entry = state.addressBook[idx];
    const current = entry.notes || '';
    const prompt = blessed.prompt({
      parent: screen,
      top: 'center', left: 'center',
      height: 'shrink', width: 70,
      border: 'line',
      label: ' Notes ',
      tags: true,
      style: { border: { fg: 'yellow' } },
    });
    prompt.input('Notes:', current, (_err, value) => {
      if (value !== null && value !== undefined) {
        state.addressBook[idx].notes = value.trim();
        if (cachedData[idx]) cachedData[idx].notes = value.trim();
        saveState(state);
        setStatus('Notes saved.', 'green');
        updateDisplay();
      }
      addrList.focus();
    });
  }

  function doCopyAddress(idx) {
    const entry = state.addressBook[idx];
    try {
      execSync('echo ' + JSON.stringify(entry.address) + ' | pbcopy');
      setStatus('Address copied to clipboard.', 'green');
    } catch {
      setStatus('Copy failed (pbcopy not available).', 'red');
    }
    addrList.focus();
  }

  function doEditBalance(idx) {
    const entry = state.addressBook[idx];
    const current = satToBtc(entry.balance || 0);
    const prompt = blessed.prompt({
      parent: screen,
      top: 'center', left: 'center',
      height: 'shrink', width: 60,
      border: 'line',
      label: ' Update Balance ',
      tags: true,
      style: { border: { fg: 'yellow' } },
    });
    prompt.input('Balance in BTC:', current, (_err, value) => {
      if (value !== null && value !== undefined) {
        const n = parseFloat(value.replace(/,/g, ''));
        if (!isNaN(n) && n >= 0) {
          const sats = Math.round(n * 1e8);
          state.addressBook[idx].balance = sats;
          if (cachedData[idx]) cachedData[idx].balance = sats;
          saveState(state);
          setStatus('Balance updated.', 'green');
          updateDisplay();
        } else {
          setStatus('Invalid amount — enter a number like 0.15', 'red');
        }
      }
      addrList.focus();
      screen.render();
    });
  }

  function doRemove(idx) {
    const entry = state.addressBook[idx];
    const question = blessed.question({
      parent: screen,
      top: 'center', left: 'center',
      height: 'shrink', width: 60,
      border: 'line',
      label: ' Confirm Delete ',
      tags: true,
      style: { border: { fg: 'red' } },
    });
    question.ask('Remove "' + entry.label + '" from portfolio? (y/n)', (_err, yes) => {
      if (yes) {
        state.addressBook.splice(idx, 1);
        cachedData.splice(idx, 1);
        saveState(state);
        log('Address removed: ' + (entry.address || entry.label));
        setStatus('Removed: ' + entry.label, 'yellow');
        updateDisplay();
        // Select the item before the removed one, or first item
        const newIdx = Math.max(0, Math.min(idx, state.addressBook.length - 1));
        if (state.addressBook.length > 0) addrList.select(newIdx);
      }
      addrList.focus();
      screen.render();
    });
  }

  function openSubmenu(idx) {
    const entry = state.addressBook[idx];
    if (!entry) return;

    const cached = cachedData[idx] || {};

    const balStr = cached.balance !== null && cached.balance !== undefined
      ? '{green-fg}' + satToBtc(cached.balance) + ' BTC{/green-fg}' +
        (btcPrice ? '  {gray-fg}($' + (cached.balance / 1e8 * btcPrice).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '){/gray-fg}' : '')
      : '{gray-fg}not yet loaded{/gray-fg}';

    const modal = blessed.box({
      parent: screen,
      top: 'center', left: 'center',
      width: '95%', height: 20,
      border: 'line',
      label: ' ' + entry.label + ' ',
      tags: true,
      style: { border: { fg: 'cyan' }, label: { fg: 'cyan', bold: true } },
    });

    const isManual = entry.type === 'manual';

    // ── Details panel ────────────────────────────────────────────────────
    const detailContent = isManual
      ? '{gray-fg}Type    :{/gray-fg}  Manual balance (off-chain)\n\n' +
        '{gray-fg}Balance :{/gray-fg}  ' + balStr + '\n' +
        '{gray-fg}Added   :{/gray-fg}  ' + (entry.addedAt ? new Date(entry.addedAt).toLocaleString() : 'unknown') + '\n' +
        '{gray-fg}Notes   :{/gray-fg}  ' + (entry.notes || '{gray-fg}(none){/gray-fg}')
      : '{gray-fg}Address :{/gray-fg}  ' + entry.address + '\n\n' +
        '{gray-fg}Balance :{/gray-fg}  ' + balStr + '\n' +
        '{gray-fg}Added   :{/gray-fg}  ' + (entry.addedAt ? new Date(entry.addedAt).toLocaleString() : 'unknown') + '\n' +
        '{gray-fg}Notes   :{/gray-fg}  ' + (entry.notes || '{gray-fg}(none){/gray-fg}');

    const details = blessed.box({
      parent: modal,
      top: 1, left: 2,
      width: '100%-4', height: 7,
      tags: true,
      content: detailContent,
    });

    const dividerTop = 8;

    // ── Divider ──────────────────────────────────────────────────────────
    const divider = blessed.box({
      parent: modal,
      top: dividerTop, left: 0,
      width: '100%', height: 1,
      content: '{gray-fg}' + '─'.repeat(60) + '{/gray-fg}',
      tags: true,
    });

    // ── Action list ──────────────────────────────────────────────────────
    const actions = isManual
      ? [
          { label: '  ✎  Edit label',         fn: () => doEditLabel(idx) },
          { label: '  ✎  Update balance',      fn: () => doEditBalance(idx) },
          { label: '  ✎  Edit notes',          fn: () => doEditNotes(idx) },
          { label: '  ✕  Remove',              fn: () => doRemove(idx) },
        ]
      : [
          { label: '  ✎  Edit label',                fn: () => doEditLabel(idx) },
          { label: '  ✎  Edit notes',                fn: () => doEditNotes(idx) },
          { label: '  ⬡  Watch transactions',         fn: () => doWatch(idx) },
          { label: '  ⎘  Copy address to clipboard',  fn: () => doCopyAddress(idx) },
          { label: '  ✕  Remove address',             fn: () => doRemove(idx) },
        ];

    const list = blessed.list({
      parent: modal,
      top: dividerTop + 1, left: 2,
      width: '100%-4', height: actions.length + 2,
      tags: true,
      items: actions.map(a => a.label),
      style: {
        selected: { bg: 'blue', fg: 'white' },
        item: { fg: 'white' },
      },
      keys: true,
      vi: true,
      mouse: true,
    });

    const hint = blessed.box({
      parent: modal,
      bottom: 1, left: 2,
      width: '100%-4', height: 1,
      tags: true,
      content: '{gray-fg}[↑↓] navigate   [Enter] select   [Esc] back{/gray-fg}',
    });

    void details; void divider; void hint;

    screen.append(modal);
    list.focus();
    screen.render();

    function closeModal() {
      modal.destroy();
      addrList.focus();
      screen.render();
    }

    list.key(['escape', 'q', 'left', 'h'], () => closeModal());

    list.on('select', (_item, i) => {
      const fn = actions[i].fn;
      closeModal();
      setImmediate(fn);
    });
  }

  // ── Key bindings ─────────────────────────────────────────────────────────

  screen.key(['r', 'R'], () => refresh());

  screen.key(['q', 'Q', 'C-c'], () => {
    if (monitor) monitor.stop();
    screen.destroy();
    process.exit(0);
  });

  screen.key(['a', 'A'], () => {
    const prompt = blessed.prompt({
      parent: screen,
      top: 'center', left: 'center',
      height: 'shrink', width: 70,
      border: 'line',
      label: ' Add Address ',
      tags: true,
      style: { border: { fg: 'yellow' } },
    });

    prompt.input('BTC address / zpub / xpub / exchange name:', '', (err, rawInput) => {
      if (err || !rawInput || !rawInput.trim()) {
        addrList.focus();
        screen.render();
        return;
      }
      const input = rawInput.trim();
      const looksLikeAddress = /^(bc1|[13]|[xyzXYZ]pub)/i.test(input);

      if (!looksLikeAddress) {
        // Manual balance entry
        prompt.input('Balance in BTC:', '0', (_err, btcInput) => {
          const n = parseFloat((btcInput || '0').replace(/,/g, ''));
          if (isNaN(n) || n < 0) {
            setStatus('Invalid amount — entry not added.', 'red');
            addrList.focus();
            return;
          }
          const sats = Math.round(n * 1e8);
          const newEntry = { type: 'manual', label: input, balance: sats, addedAt: Date.now() };
          state.addressBook.push(newEntry);
          cachedData.push({ ...newEntry, error: null });
          saveState(state);
          log('Manual entry added: ' + input + ' (' + satToBtc(sats) + ' BTC)');
          setStatus('Added: ' + input, 'green');
          addrList.focus();
          updateDisplay();
        });
        return;
      }

      if (state.addressBook.some(e => e.address === input)) {
        setStatus('Address already in portfolio.', 'yellow');
        addrList.focus();
        return;
      }

      const defaultLabel = shortAddr(input);
      prompt.input('Label (Enter for default):', defaultLabel, (_err, labelInput) => {
        const label = (labelInput && labelInput.trim()) ? labelInput.trim() : defaultLabel;
        const newEntry = { address: input, label, addedAt: Date.now() };
        state.addressBook.push(newEntry);
        cachedData.push({ ...newEntry, balance: null, txCount: null, error: null });
        saveState(state);
        log('Address added: ' + input + ' (' + label + ')');
        addrList.focus();
        const newIdx = state.addressBook.length - 1;
        if (monitor) {
          if (isExtendedKey(input)) {
            try { monitor.watch(deriveReceiveAddresses(input, 110)); } catch { /* ignore */ }
          } else {
            monitor.watch([input]);
          }
        }
        refreshOne(newIdx);
      });
    });
  });

  // [d] as a quick-delete shortcut (also available via submenu)
  screen.key(['d', 'D', 'delete'], () => {
    const idx = addrList.selected;
    if (idx === undefined || !state.addressBook[idx]) return;
    doRemove(idx);
  });

  // [w] as a quick-watch shortcut (also available via submenu)
  screen.key(['w', 'W'], () => {
    const idx = addrList.selected;
    if (idx === undefined || !state.addressBook[idx]) return;
    doWatch(idx);
  });

  // Enter opens the submenu
  screen.key(['enter'], () => {
    const idx = addrList.selected;
    if (idx === undefined || !state.addressBook[idx]) return;
    openSubmenu(idx);
  });

  if (state.addressBook.length === 0) {
    setStatus('Ready  —  press [a] to add your first address', 'gray');
    updateDisplay();
  } else {
    updateDisplay();
    const hasCache = state.addressBook.some(e => e.cachedBalance !== undefined);
    if (hasCache && state.lastFetched) {
      const mins = Math.round((Date.now() - state.lastFetched) / 60000);
      const ago = mins < 1 ? 'just now' : mins + ' min ago';
      setStatus('Cached from ' + ago + '  —  press [r] to refresh', 'gray');
      startMonitor();
      // Silently refresh price in background so USD values are current
      getBtcPrice().then(p => { if (p) { btcPrice = p; state.lastBtcPrice = p; saveState(state); updateDisplay(); } }).catch(() => {});
    } else {
      refresh();
    }
  }
}

module.exports = { runMenu };
