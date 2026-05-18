'use strict';

const { getAddressInfo, getTransactions, getXpubInfo, getXpubTransactions, getBtcPrice, getIncomingTxs, isExtendedKey } = require('./api');
const { loadState, saveState, log } = require('./store');
const { createUI } = require('./ui');

async function pollAddress(address, state, ui, price) {
  try {
    ui.setStatus('Fetching…', 'cyan');
    const [addrInfo, txs, newPrice] = await Promise.all([
      getAddressInfo(address),
      getTransactions(address),
      getBtcPrice(),
    ]);

    const btcPrice = newPrice || price;
    const incoming = getIncomingTxs(txs, address);

    const newTxIds = incoming
      .map(tx => tx.txid)
      .filter(id => !state.seenTxIds.includes(id));

    if (newTxIds.length > 0) {
      newTxIds.forEach(id => {
        log('NEW TX for ' + address + ': ' + id);
        state.seenTxIds.push(id);
      });
      saveState(state);
      ui.flashNew(newTxIds.length);
    } else {
      ui.setStatus('Last updated: ' + new Date().toLocaleTimeString(), 'gray');
    }

    ui.updateStats(addrInfo, btcPrice);
    ui.updateTxList(incoming, btcPrice, newTxIds);
    return btcPrice;
  } catch (err) {
    ui.setStatus('Error: ' + err.message, 'red');
    log('ERROR: ' + err.message);
    return price;
  }
}

async function pollXpub(xpub, state, ui, price) {
  try {
    ui.setStatus('Fetching…', 'cyan');
    const [xpubInfo, txs, newPrice] = await Promise.all([
      getXpubInfo(xpub),
      getXpubTransactions(xpub),
      getBtcPrice(),
    ]);

    const btcPrice = newPrice || price;

    const newTxIds = txs
      .map(tx => tx.txid)
      .filter(id => !state.seenTxIds.includes(id));

    if (newTxIds.length > 0) {
      newTxIds.forEach(id => {
        log('NEW TX for xpub ' + xpub.slice(0, 16) + '…: ' + id);
        state.seenTxIds.push(id);
      });
      saveState(state);
      ui.flashNew(newTxIds.length);
    } else {
      ui.setStatus('Last updated: ' + new Date().toLocaleTimeString(), 'gray');
    }

    ui.updateStats(xpubInfo, btcPrice);
    ui.updateTxList(txs, btcPrice, newTxIds, true);
    return btcPrice;
  } catch (err) {
    ui.setStatus('Error: ' + err.message, 'red');
    log('ERROR: ' + err.message);
    return price;
  }
}

function watch(address, opts) {
  opts = opts || {};
  const interval = (opts.interval || 60) * 1000;
  const state = loadState();
  const ui = createUI(address);

  let btcPrice = null;
  let timer;

  async function refresh() {
    btcPrice = await pollAddress(address, state, ui, btcPrice);
  }

  ui.screen.key(['r', 'R'], () => {
    clearTimeout(timer);
    refresh().then(() => { timer = setTimeout(loop, interval); });
  });

  ui.screen.key(['q', 'Q', 'escape'], () => {
    clearTimeout(timer);
    ui.screen.destroy();
    if (opts.onExit) opts.onExit();
    else process.exit(0);
  });

  ui.screen.key(['C-c'], () => {
    clearTimeout(timer);
    ui.screen.destroy();
    process.exit(0);
  });

  function loop() {
    refresh().then(() => { timer = setTimeout(loop, interval); });
  }

  log('Started watching ' + address + ' (interval: ' + (opts.interval || 60) + 's)');
  loop();
}

function watchXpub(xpub, opts) {
  opts = opts || {};
  const interval = (opts.interval || 60) * 1000;
  const state = loadState();
  const ui = createUI(xpub.slice(0, 12) + '…', { isXpub: true });

  let btcPrice = null;
  let timer;

  async function refresh() {
    btcPrice = await pollXpub(xpub, state, ui, btcPrice);
  }

  ui.screen.key(['r', 'R'], () => {
    clearTimeout(timer);
    refresh().then(() => { timer = setTimeout(loop, interval); });
  });

  ui.screen.key(['q', 'Q', 'escape'], () => {
    clearTimeout(timer);
    ui.screen.destroy();
    if (opts.onExit) opts.onExit();
    else process.exit(0);
  });

  ui.screen.key(['C-c'], () => {
    clearTimeout(timer);
    ui.screen.destroy();
    process.exit(0);
  });

  function loop() {
    refresh().then(() => { timer = setTimeout(loop, interval); });
  }

  log('Started watching xpub ' + xpub.slice(0, 16) + '… (interval: ' + (opts.interval || 60) + 's)');
  loop();
}

function watchAddress(address, opts) {
  if (isExtendedKey(address)) {
    watchXpub(address, opts);
  } else {
    watch(address, opts);
  }
}

module.exports = { watch, watchXpub, watchAddress };
