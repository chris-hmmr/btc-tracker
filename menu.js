'use strict';

const blessed = require('blessed');
const { loadState, saveState, log } = require('./store');
const { getAnyAddressInfo, getBtcPrice, satToBtc } = require('./api');

function shortAddr(addr) {
  if (addr.length <= 20) return addr;
  return addr.slice(0, 10) + '…' + addr.slice(-6);
}

async function fetchAllBalances(addressBook) {
  return Promise.all(addressBook.map(async (entry) => {
    try {
      const info = await getAnyAddressInfo(entry.address);
      const recv = info.chain_stats.funded_txo_sum + info.mempool_stats.funded_txo_sum;
      const spent = info.chain_stats.spent_txo_sum + info.mempool_stats.spent_txo_sum;
      return { ...entry, balance: recv - spent, txCount: info.chain_stats.tx_count + info.mempool_stats.tx_count, error: null };
    } catch (err) {
      return { ...entry, balance: null, txCount: null, error: err.message };
    }
  }));
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
    ' {yellow-fg}██████╔╝   ██║    ╚██████╗{/yellow-fg}  {gray-fg}↑↓ navigate  [a] add  [d] delete  [w] watch  [r] refresh  [q] quit{/gray-fg}',
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

  let cachedData = [];
  let btcPrice = null;

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
        return ' {cyan-fg}' + label + '{/cyan-fg}  {gray-fg}' + addrShort + '{/gray-fg}  {gray-fg}loading…{/gray-fg}';
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

  async function refresh() {
    setStatus('Fetching balances…', 'cyan');
    cachedData = state.addressBook.map(e => ({ ...e, balance: null, txCount: null, error: null }));
    updateDisplay();

    try {
      const [newData, newPrice] = await Promise.all([
        fetchAllBalances(state.addressBook),
        getBtcPrice(),
      ]);
      cachedData = newData;
      if (newPrice) btcPrice = newPrice;
      setStatus('Last refreshed: ' + new Date().toLocaleTimeString(), 'gray');
    } catch (err) {
      setStatus('Refresh error: ' + err.message, 'red');
    }
    updateDisplay();
  }

  screen.key(['r', 'R'], () => refresh());

  screen.key(['q', 'Q', 'C-c'], () => {
    screen.destroy();
    process.exit(0);
  });

  screen.key(['a', 'A'], () => {
    const prompt = blessed.prompt({
      parent: screen,
      top: 'center',
      left: 'center',
      height: 'shrink',
      width: 70,
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
        state.addressBook.push({ address, label, addedAt: Date.now() });
        saveState(state);
        log('Address added: ' + address + ' (' + label + ')');
        setStatus('Added: ' + label, 'green');
        addrList.focus();
        refresh();
      });
    });
  });

  screen.key(['d', 'D', 'delete'], () => {
    const idx = addrList.selected;
    if (idx === undefined || !state.addressBook[idx]) return;

    const entry = state.addressBook[idx];
    const question = blessed.question({
      parent: screen,
      top: 'center',
      left: 'center',
      height: 'shrink',
      width: 60,
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
  });

  screen.key(['w', 'W', 'enter'], () => {
    const idx = addrList.selected;
    if (idx === undefined || !state.addressBook[idx]) return;

    const entry = state.addressBook[idx];
    screen.destroy();

    const { watchAddress } = require('./watcher');
    watchAddress(entry.address, { interval: 60, onExit: runMenu });
  });

  if (state.addressBook.length === 0) {
    setStatus('Ready  —  press [a] to add your first address', 'gray');
    updateDisplay();
  } else {
    refresh();
  }
}

module.exports = { runMenu };
