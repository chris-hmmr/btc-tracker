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
