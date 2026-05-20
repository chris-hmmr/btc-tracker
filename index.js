#!/usr/bin/env node
'use strict';

const { Command } = require('commander');
const path = require('path');
const fs = require('fs');

const program = new Command();

program
  .name('btc-tracker')
  .description('Bitcoin portfolio tracker with TUI')
  .version('1.0.0');

program
  .command('menu', { isDefault: true })
  .description('Open the interactive portfolio manager (default)')
  .action(() => {
    const { runMenu } = require('./menu');
    runMenu();
  });

program
  .command('watch <address>')
  .description('Watch an address or zpub/xpub in the transaction dashboard')
  .option('-i, --interval <seconds>', 'Polling interval in seconds', '60')
  .action((address, opts) => {
    const { watchAddress } = require('./watcher');
    watchAddress(address, { interval: parseInt(opts.interval, 10) });
  });

program
  .command('report <address>')
  .description('Print a one-shot report and exit')
  .action(async (address) => {
    const { report } = require('./report');
    await report(address);
    process.exit(0);
  });

program
  .command('daemon <address>')
  .description('Run as a background daemon, logs to ~/.btc-tracker/tracker.log')
  .option('-i, --interval <seconds>', 'Polling interval in seconds', '60')
  .action((address, opts) => {
    const { runDaemon } = require('./daemon');
    runDaemon(address, { interval: parseInt(opts.interval, 10) });
  });

program
  .command('logs')
  .description('Tail the tracker log file')
  .action(() => {
    const { getLogPath } = require('./store');
    const logPath = getLogPath();
    if (!fs.existsSync(logPath)) {
      console.log('No log file yet. Start tracking first.');
      process.exit(1);
    }
    const { execSync } = require('child_process');
    try {
      execSync(`tail -f "${logPath}"`, { stdio: 'inherit' });
    } catch {}
  });

program
  .command('derive <extkey>')
  .description('Print derived addresses from a zpub/xpub for verification')
  .option('-n, --count <n>', 'number of addresses per chain', '10')
  .action((extkey, opts) => {
    const { HDKey } = require('@scure/bip32');
    const { pubkeyToAddress, getVersions } = require('./xpub');
    const n = Math.max(1, parseInt(opts.count, 10) || 10);
    const versions = getVersions(extkey);
    const root = HDKey.fromExtendedKey(extkey, versions);
    console.log('\nReceive addresses (chain 0):');
    const recvNode = root.deriveChild(0);
    for (let i = 0; i < n; i++) {
      console.log(`  [${i}] ${pubkeyToAddress(recvNode.deriveChild(i).publicKey, extkey)}`);
    }
    console.log('\nChange addresses (chain 1):');
    const changeNode = root.deriveChild(1);
    for (let i = 0; i < n; i++) {
      console.log(`  [${i}] ${pubkeyToAddress(changeNode.deriveChild(i).publicKey, extkey)}`);
    }
    console.log('');
  });

program
  .command('import-csv <file>')
  .description('Import Bitcoin addresses from a Coinfinity order CSV into the portfolio')
  .action((file) => {
    const absPath = path.resolve(file);
    if (!fs.existsSync(absPath)) {
      console.error('File not found:', absPath);
      process.exit(1);
    }
    const { loadState, saveState } = require('./store');
    const content = fs.readFileSync(absPath, 'utf8');
    const lines = content.trim().split('\n');
    const header = lines[0].split(',').map(h => h.replace(/"/g, '').trim());
    const addrIdx = header.indexOf('Address');
    if (addrIdx === -1) {
      console.error('No "Address" column found. Is this a Coinfinity CSV?');
      process.exit(1);
    }
    const state = loadState();
    const existing = new Set(state.addressBook.map(e => e.address));
    let added = 0;
    const seen = new Set();
    for (let i = 1; i < lines.length; i++) {
      // Naive CSV parse: split on comma outside quotes
      const cols = lines[i].match(/(".*?"|[^,]+)(?=,|$)/g) || [];
      const addr = (cols[addrIdx] || '').replace(/"/g, '').trim();
      if (!addr || seen.has(addr) || existing.has(addr)) continue;
      seen.add(addr);
      state.addressBook.push({ address: addr, label: addr.slice(0, 10) + '…', addedAt: Date.now() });
      added++;
    }
    saveState(state);
    console.log('Imported ' + added + ' new address' + (added !== 1 ? 'es' : '') + ' from ' + path.basename(absPath) + '.');
    console.log('Open the portfolio menu to refresh balances.');
  });

program
  .command('clear-state')
  .description('Clear saved state (seen tx IDs, address book, etc.)')
  .action(() => {
    const { getDataDir } = require('./store');
    const stateFile = path.join(getDataDir(), 'state.json');
    if (fs.existsSync(stateFile)) {
      fs.unlinkSync(stateFile);
      console.log('State cleared.');
    } else {
      console.log('No state file found.');
    }
  });

program.parse(process.argv);
