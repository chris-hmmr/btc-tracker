'use strict';

const { getAddressInfo, getTransactions, getBtcPrice, getIncomingTxs, satToBtc } = require('./api');
const { loadState, saveState, log } = require('./store');

async function poll(address, state) {
  try {
    const [addrInfo, txs, price] = await Promise.all([
      getAddressInfo(address),
      getTransactions(address),
      getBtcPrice(),
    ]);

    const incoming = getIncomingTxs(txs, address);
    const recv = addrInfo.chain_stats.funded_txo_sum + addrInfo.mempool_stats.funded_txo_sum;
    const spent = addrInfo.chain_stats.spent_txo_sum + addrInfo.mempool_stats.spent_txo_sum;
    const balance = recv - spent;

    const newTxs = incoming.filter(tx => !state.seenTxIds.includes(tx.txid));

    if (newTxs.length > 0) {
      newTxs.forEach(tx => {
        const btc = satToBtc(tx.received);
        const usdStr = price ? ` ($${(tx.received / 1e8 * price).toFixed(2)})` : '';
        const conf = tx.status.confirmed ? 'confirmed' : 'UNCONFIRMED';
        log(`NEW TX [${conf}] +${btc} BTC${usdStr} | txid: ${tx.txid}`);
        state.seenTxIds.push(tx.txid);
      });
      saveState(state);
    }

    log(`POLL OK | balance: ${satToBtc(balance)} BTC | txs: ${incoming.length} incoming | ${newTxs.length} new`);
  } catch (err) {
    log(`POLL ERROR: ${err.message}`);
  }
}

function runDaemon(address, opts = {}) {
  const interval = (opts.interval || 60) * 1000;
  const state = loadState();

  log(`Daemon started for ${address} (interval: ${opts.interval || 60}s, PID: ${process.pid})`);
  console.log(`[btc-tracker] Daemon running for ${address}`);
  console.log(`[btc-tracker] PID: ${process.pid}`);
  console.log(`[btc-tracker] Polling every ${opts.interval || 60}s`);
  console.log(`[btc-tracker] Logs: ~/.btc-tracker/tracker.log`);
  console.log(`[btc-tracker] Stop with: kill ${process.pid}  or  Ctrl+C`);

  // Write PID file
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const pidFile = path.join(os.homedir(), '.btc-tracker', 'daemon.pid');
  fs.writeFileSync(pidFile, String(process.pid));

  process.on('SIGTERM', () => {
    log('Daemon stopped (SIGTERM)');
    try { fs.unlinkSync(pidFile); } catch {}
    process.exit(0);
  });

  process.on('SIGINT', () => {
    log('Daemon stopped (SIGINT)');
    try { fs.unlinkSync(pidFile); } catch {}
    process.exit(0);
  });

  function loop() {
    poll(address, state).then(() => setTimeout(loop, interval));
  }

  loop();
}

module.exports = { runDaemon };
