'use strict';

const chalk = require('chalk');
const { getAddressInfo, getTransactions, getBtcPrice, getIncomingTxs, satToBtc } = require('./api');

function timeAgo(ts) {
  if (!ts) return chalk.yellow('unconfirmed');
  const d = Math.floor(Date.now() / 1000 - ts);
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

async function report(address) {
  console.log(chalk.cyan('\n🔍 Fetching data for:'), chalk.white(address), '\n');

  try {
    const [addrInfo, txs, price] = await Promise.all([
      getAddressInfo(address),
      getTransactions(address),
      getBtcPrice(),
    ]);

    const recv = addrInfo.chain_stats.funded_txo_sum + addrInfo.mempool_stats.funded_txo_sum;
    const spent = addrInfo.chain_stats.spent_txo_sum + addrInfo.mempool_stats.spent_txo_sum;
    const balance = recv - spent;
    const txCount = addrInfo.chain_stats.tx_count + addrInfo.mempool_stats.tx_count;

    const usd = (sat) => price ? chalk.gray(` ($${(sat / 1e8 * price).toFixed(2)})`) : '';

    console.log(chalk.bold('─── Summary ───────────────────────────────'));
    console.log(`  ${chalk.cyan('Total received:')} ${chalk.white(satToBtc(recv) + ' BTC')}${usd(recv)}`);
    console.log(`  ${chalk.cyan('Balance:        ')} ${chalk.white(satToBtc(balance) + ' BTC')}${usd(balance)}`);
    console.log(`  ${chalk.cyan('Transactions:   ')} ${txCount}`);
    if (price) console.log(`  ${chalk.cyan('BTC price:      ')} $${price.toLocaleString()}`);
    console.log();

    const incoming = getIncomingTxs(txs, address);

    if (incoming.length === 0) {
      console.log(chalk.gray('  No incoming transactions found.\n'));
      return;
    }

    console.log(chalk.bold('─── Incoming Transactions ──────────────────'));
    incoming.forEach((tx, i) => {
      const conf = tx.status.confirmed;
      const badge = conf ? chalk.green('✓ confirmed  ') : chalk.yellow('⏳ unconfirmed');
      const amount = chalk.green(`+${satToBtc(tx.received)} BTC`) + usd(tx.received);
      const hash = chalk.gray(tx.txid.slice(0, 16) + '…' + tx.txid.slice(-8));
      const when = timeAgo(tx.status.block_time);
      const block = conf ? chalk.gray(`  block ${tx.status.block_height}`) : '';
      console.log(`  ${i + 1}. ${badge}  ${amount}  ${hash}  ${when}${block}`);
    });
    console.log();
  } catch (err) {
    console.error(chalk.red('Error:'), err.message);
    process.exit(1);
  }
}

module.exports = { report };
