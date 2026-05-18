# btc-tracker

A CLI Bitcoin portfolio tracker with an interactive TUI. Add multiple BTC addresses or zpub/xpub keys, monitor balances, and track incoming transactions — all from the terminal.

## Install

```bash
cd btc-tracker
npm install
npm link   # optional — makes `btc-tracker` available as a global command
```

## Running the app

```bash
node src/index.js
# or if globally linked:
btc-tracker
```

This opens the **portfolio menu** — the main screen of the app.

## Portfolio menu

The default view on launch. Shows all your tracked addresses with live balances and a portfolio total.

```
  ██████╗ ████████╗  ██████╗
  ██╔══██╗╚══██╔══╝ ██╔════╝   T R A C K E R
  ██████╔╝   ██║    ██║        Portfolio Manager
  ...

  Label            Address              Balance          Txs
  My Wallet        zpub6Cng…k3fx        0.58142000 BTC   12
  Cold Storage     bc1q…xyz             1.20000000 BTC    5

  Total Balance:  1.78142000 BTC  (≈ $89,071)
```

**Keys:**
| Key | Action |
|-----|--------|
| `↑` / `↓` | Navigate addresses |
| `a` | Add a new address or zpub/xpub |
| `d` | Delete selected address |
| `w` / `Enter` | Open transaction watcher for selected address |
| `r` | Refresh all balances |
| `q` | Quit |

## Adding addresses

Press `[a]` in the menu and enter any of:
- A standard BTC address: `bc1q…`, `1…`, `3…`
- An extended public key: `zpub…`, `xpub…`, `ypub…`

You'll be prompted for an optional label. Addresses are saved locally to `~/.btc-tracker/state.json` and loaded automatically on every launch.

## Transaction watcher

Press `[w]` on any address in the menu to open a live transaction dashboard for that address. Shows balance stats, incoming transactions, and alerts on new activity. Press `[q]` to return to the portfolio menu.

## CLI commands

You can also use commands directly without the menu:

```bash
# Watch a specific address or zpub in the transaction dashboard
btc-tracker watch <address-or-zpub>
btc-tracker watch <address-or-zpub> -i 30   # poll every 30s

# One-shot balance report, then exit
btc-tracker report <address-or-zpub>

# Background daemon (no TUI), logs to ~/.btc-tracker/tracker.log
btc-tracker daemon <address-or-zpub>
btc-tracker daemon <address-or-zpub> &          # run in background
nohup btc-tracker daemon <address-or-zpub> > /dev/null 2>&1 &

# Stop the daemon
kill $(cat ~/.btc-tracker/daemon.pid)

# Tail the log file
btc-tracker logs

# Clear saved state (seen tx IDs, etc.)
btc-tracker clear-state
```

## Data & privacy

All data is stored locally in `~/.btc-tracker/` — never sent anywhere except the public [mempool.space](https://mempool.space) API (no account or API key required):

| File | Contents |
|------|----------|
| `state.json` | Address book, seen transaction IDs |
| `tracker.log` | Append-only log of polls and new transactions |
| `daemon.pid` | PID of a running daemon (if any) |

This directory is outside the project folder and is never committed to git.
