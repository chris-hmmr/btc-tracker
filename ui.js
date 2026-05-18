const blessed = require('blessed');
const { satToBtc } = require('./api');

function timeAgo(ts) {
  if (!ts) return 'unconfirmed';
  const d = Math.floor(Date.now() / 1000 - ts);
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

function usd(sat, price) {
  if (!price) return '';
  return ' ($' + (sat / 1e8 * price).toFixed(2) + ')';
}

function createUI(address, opts) {
  opts = opts || {};

  const screen = blessed.screen({
    smartCSR: true,
    title: 'BTC Tracker',
    fullUnicode: true,
  });

  const header = blessed.box({
    top: 0, left: 0, width: '100%', height: 4,
    content: `  {yellow-fg}₿{/yellow-fg}  {bold}BTC TRACKER{/bold}\n  {gray-fg}Watching: ${address}{/gray-fg}`,
    tags: true,
    border: { type: 'line' },
    style: { fg: 'white', bg: 'black' },
  });

  const statsBox = blessed.box({
    top: 4, left: 0, width: '100%', height: 5,
    tags: true,
    border: { type: 'line' },
    label: ' Stats ',
    style: { border: { fg: 'cyan' } },
  });

  const txBoxLabel = opts.isXpub ? ' Transactions ' : ' Incoming Transactions ';
  const txBox = blessed.list({
    top: 9, left: 0, width: '100%', height: '100%-12',
    tags: true,
    border: { type: 'line' },
    label: txBoxLabel,
    style: {
      border: { fg: 'cyan' },
      selected: { bg: 'blue' },
      item: { fg: 'white' },
    },
    keys: true,
    vi: true,
    mouse: true,
    scrollable: true,
    scrollbar: { ch: '│', style: { fg: 'cyan' } },
  });

  const quitHint = opts.onExit ? '[q] back to menu' : '[q] quit';
  const statusBar = blessed.box({
    bottom: 0, left: 0, width: '100%', height: 3,
    content: ` {gray-fg}[r] refresh  ${quitHint}{/gray-fg}`,
    tags: true,
    border: { type: 'line' },
    style: { border: { fg: 'gray' } },
  });

  screen.append(header);
  screen.append(statsBox);
  screen.append(txBox);
  screen.append(statusBar);

  txBox.focus();

  function updateStats(addrInfo, price) {
    const recv = addrInfo.chain_stats.funded_txo_sum + addrInfo.mempool_stats.funded_txo_sum;
    const spent = addrInfo.chain_stats.spent_txo_sum + addrInfo.mempool_stats.spent_txo_sum;
    const balance = recv - spent;
    const txCount = addrInfo.chain_stats.tx_count + addrInfo.mempool_stats.tx_count;
    const unconf = addrInfo.mempool_stats.tx_count;

    statsBox.setContent(
      `  {cyan-fg}Received:{/cyan-fg}  {bold}${satToBtc(recv)} BTC{/bold}${usd(recv, price)}\n` +
      `  {cyan-fg}Balance:{/cyan-fg}   {bold}${satToBtc(balance)} BTC{/bold}${usd(balance, price)}\n` +
      `  {cyan-fg}Txs:{/cyan-fg}       ${txCount} total  {yellow-fg}${unconf} unconfirmed{/yellow-fg}`
    );
    screen.render();
  }

  function updateTxList(txs, price, newTxIds, isXpub) {
    newTxIds = newTxIds || [];
    isXpub = isXpub || false;

    if (txs.length === 0) {
      txBox.setItems([' {gray-fg}No ' + (isXpub ? '' : 'incoming ') + 'transactions yet.{/gray-fg}']);
      screen.render();
      return;
    }

    const items = txs.map(tx => {
      const isNew = newTxIds.includes(tx.txid);
      const conf = tx.status.confirmed;
      const confBadge = conf
        ? `{green-fg}✓ confirmed{/green-fg}`
        : `{yellow-fg}⏳ unconfirmed{/yellow-fg}`;
      const newBadge = isNew ? ` {magenta-fg}★ NEW{/magenta-fg}` : '';
      const block = conf ? `  block ${tx.status.block_height}` : '';
      const hashShort = tx.txid.slice(0, 12) + '…' + tx.txid.slice(-8);
      const amount = !isXpub
        ? `  {bold}{green-fg}+${satToBtc(tx.received)} BTC{/green-fg}{/bold}${usd(tx.received, price)}`
        : '';
      return ` ${confBadge}${newBadge}${amount}  {gray-fg}${hashShort}  ${timeAgo(tx.status.block_time)}${block}{/gray-fg}`;
    });

    txBox.setItems(items);
    screen.render();
  }

  function setStatus(msg, color) {
    color = color || 'white';
    statusBar.setContent(
      ` {${color}-fg}${msg}{/${color}-fg}  {gray-fg}[r] refresh  ${quitHint}{/gray-fg}`
    );
    screen.render();
  }

  function flashNew(count) {
    if (count > 0) setStatus(`🔔 ${count} new transaction(s) detected!`, 'magenta');
  }

  return { screen, updateStats, updateTxList, setStatus, flashNew };
}

module.exports = { createUI };
