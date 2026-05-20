'use strict';

const { execSync } = require('child_process');
const blessed = require('blessed');
const { loadState, saveState, log } = require('./store');
const { getAnyAddressInfo, getBtcPrice, satToBtc, isExtendedKey } = require('./api');
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
        const info = await getAnyAddressInfo(entry.address, {
          gapLimit: entry.gapLimit,
          onProgress: onProgress ? (msg) => onProgress(absIdx, msg) : undefined,
        });
        const recv = info.chain_stats.funded_txo_sum + info.mempool_stats.funded_txo_sum;
        const spent = info.chain_stats.spent_txo_sum + info.mempool_stats.spent_txo_sum;
        return { ...entry, balance: recv - spent, txCount: info.chain_stats.tx_count + info.mempool_stats.tx_count, error: null };
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
    top: 8, left: 0, width: '100%', height: '100%-16',
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
    bottom: 3, left: 0, width: '100%', height: 5,
    tags: true,
    border: { type: 'line' },
    label: ' Portfolio Total ',
    style: { border: { fg: 'green' } },
  });

  const statusBar = blessed.box({
    bottom: 0, left: 0, width: '100%', height: 3,
    tags: true,
    border: { type: 'line' },
    style: { border: { fg: 'gray' } },
  });

  screen.append(header);
  screen.append(addrList);
  screen.append(totalBox);
  screen.append(statusBar);
  addrList.focus();

  let cachedData = state.addressBook.map(e => ({
    ...e,
    balance: e.cachedBalance !== undefined ? e.cachedBalance : null,
    txCount: e.cachedTxCount !== undefined ? e.cachedTxCount : null,
    error: null,
  }));
  let btcPrice = null;
  let monitor = null;
  const refreshPending = new Set();

  function startMonitor() {
    if (monitor) { monitor.stop(); monitor = null; }
    if (state.addressBook.length === 0) return;

    const watchMap = buildWatchMap(state.addressBook);
    if (Object.keys(watchMap).length === 0) return;

    monitor = new AddressMonitor(
      (address) => {
        const idx = watchMap[address];
        if (idx === undefined || refreshPending.has(idx)) return;
        refreshPending.add(idx);
        setStatus('New transaction detected — updating…', 'yellow');
        refreshOne(idx).finally(() => {
          refreshPending.delete(idx);
          setStatus('● live', 'green');
        });
      },
      (status) => {
        if (status === 'connected') setStatus('● live', 'green');
        else if (status === 'connecting') setStatus('◌ connecting…', 'gray');
        else if (status === 'disconnected') setStatus('○ reconnecting…', 'yellow');
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
      const addrShort = shortAddr(entry.address).padEnd(20);

      if (entry.error) {
        return ' {yellow-fg}' + label + '{/yellow-fg}  {gray-fg}' + addrShort + '{/gray-fg}  {red-fg}fetch error{/red-fg}';
      }
      if (entry.balance === null) {
        const prog = entry.progressMsg || 'loading…';
        return ' {cyan-fg}' + label + '{/cyan-fg}  {gray-fg}' + addrShort + '{/gray-fg}  {gray-fg}' + prog + '{/gray-fg}';
      }

      const balStr = (satToBtc(entry.balance) + ' BTC').padEnd(16);
      const usdStr = btcPrice
        ? '{gray-fg} $' + (entry.balance / 1e8 * btcPrice).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) + '{/gray-fg}'
        : '';
      const txStr = '{gray-fg}' + entry.txCount + ' txs{/gray-fg}';
      return ' {cyan-fg}' + label + '{/cyan-fg}  {gray-fg}' + addrShort + '{/gray-fg}  {bold}{green-fg}' + balStr + '{/green-fg}{/bold}' + usdStr + '  ' + txStr;
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
      if (newPrice) btcPrice = newPrice;
      newData.forEach((entry, i) => {
        if (state.addressBook[i] && entry.balance !== null && !entry.error) {
          state.addressBook[i].cachedBalance = entry.balance;
          state.addressBook[i].cachedTxCount = entry.txCount;
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
        log('Address removed: ' + entry.address);
        setStatus('Removed: ' + entry.label, 'yellow');
        updateDisplay();
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

    // ── Details panel ────────────────────────────────────────────────────
    const details = blessed.box({
      parent: modal,
      top: 1, left: 2,
      width: '100%-4', height: 7,
      tags: true,
      content:
        '{gray-fg}Address :{/gray-fg}  ' + entry.address + '\n\n' +
        '{gray-fg}Balance :{/gray-fg}  ' + balStr + '\n' +
        '{gray-fg}Added   :{/gray-fg}  ' + (entry.addedAt ? new Date(entry.addedAt).toLocaleString() : 'unknown') + '\n' +
        '{gray-fg}Notes   :{/gray-fg}  ' + (entry.notes || '{gray-fg}(none){/gray-fg}'),
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

    // ── Action list (dynamic based on address type) ───────────────────────
    const actions = [
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

    prompt.input('BTC address / zpub / xpub:', '', (err, addrInput) => {
      if (err || !addrInput || !addrInput.trim()) {
        addrList.focus();
        screen.render();
        return;
      }
      const address = addrInput.trim();

      if (state.addressBook.some(e => e.address === address)) {
        setStatus('Address already in portfolio.', 'yellow');
        addrList.focus();
        return;
      }

      const defaultLabel = shortAddr(address);
      prompt.input('Label (Enter for default):', defaultLabel, (_err, labelInput) => {
        const label = (labelInput && labelInput.trim()) ? labelInput.trim() : defaultLabel;
        const newEntry = { address, label, addedAt: Date.now() };
        state.addressBook.push(newEntry);
        cachedData.push({ ...newEntry, balance: null, txCount: null, error: null });
        saveState(state);
        log('Address added: ' + address + ' (' + label + ')');
        addrList.focus();
        const newIdx = state.addressBook.length - 1;
        // Subscribe the new address to live monitoring
        if (monitor) {
          if (isExtendedKey(address)) {
            try { monitor.watch(deriveReceiveAddresses(address, 110)); } catch { /* ignore */ }
          } else {
            monitor.watch([address]);
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
    } else {
      refresh();
    }
  }
}

module.exports = { runMenu };
