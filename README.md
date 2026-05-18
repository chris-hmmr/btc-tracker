# btc-tracker

A CLI Bitcoin address transaction tracker. Runs as an interactive TUI, a background daemon, or a one-shot report.

## Install

```bash
cd btc-tracker
npm install
npm link   # makes `btc-tracker` available globally (optional)
```

## Usage

### Interactive TUI dashboard
Opens a live terminal dashboard. Polls every 60s, press `r` to refresh manually.

```bash
node src/index.js watch <your-btc-address>
# or if globally linked:
btc-tracker watch <your-btc-address>
```

Options:
- `-i, --interval <seconds>` — polling interval (default: 60)

### Background daemon
Runs silently in the background. Logs all activity and new transactions to `~/.btc-tracker/tracker.log`.

```bash
# Run in background, keep terminal free
node src/index.js daemon <your-btc-address> &

# Or detach fully with nohup
nohup node src/index.js daemon <your-btc-address> > /dev/null 2>&1 &
```

Stop it:
```bash
# PID is printed on start, or read from:
kill $(cat ~/.btc-tracker/daemon.pid)
```

### One-shot report
Fetch and print current state, then exit.

```bash
node src/index.js report <your-btc-address>
```

### Tail logs
```bash
node src/index.js logs
# or directly:
tail -f ~/.btc-tracker/tracker.log
```

### Clear saved state
Resets seen transaction IDs (so all txs appear as "new" again on next run):
```bash
node src/index.js clear-state
```

## State & logs

All data is stored in `~/.btc-tracker/`:
- `state.json` — seen transaction IDs (to detect new ones)
- `tracker.log` — append-only log of all polls and new transactions
- `daemon.pid` — PID of running daemon (if any)

## Notes

- Uses the public [mempool.space](https://mempool.space) API — no API key needed.
- New transactions are detected by comparing against previously seen tx IDs stored in `~/.btc-tracker/state.json`.
- In daemon mode, new transactions trigger a log entry — hook this up to a notification service if needed.
