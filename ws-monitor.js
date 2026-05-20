'use strict';

const WebSocket = require('ws');

const WS_URL = 'wss://mempool.space/api/v1/ws';
const RECONNECT_BASE_MS = 5000;
const RECONNECT_MAX_MS = 60000;

class AddressMonitor {
  constructor(onActivity, onStatusChange) {
    this.onActivity = onActivity;       // (address) => void
    this.onStatusChange = onStatusChange; // ('connecting'|'connected'|'disconnected') => void
    this.addresses = new Set();
    this.ws = null;
    this._stopped = false;
    this._reconnectDelay = RECONNECT_BASE_MS;
    this._reconnectTimer = null;
  }

  watch(addresses) {
    addresses.forEach(a => this.addresses.add(a));
    this._sendSub();
  }

  start() {
    this._stopped = false;
    this._reconnectDelay = RECONNECT_BASE_MS;
    this._connect();
  }

  stop() {
    this._stopped = true;
    clearTimeout(this._reconnectTimer);
    if (this.ws) { this.ws.terminate(); this.ws = null; }
  }

  _connect() {
    if (this._stopped) return;
    if (this.onStatusChange) this.onStatusChange('connecting');

    try {
      this.ws = new WebSocket(WS_URL);
    } catch {
      this._scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      this._reconnectDelay = RECONNECT_BASE_MS;
      if (this.onStatusChange) this.onStatusChange('connected');
      this._sendSub();
    });

    this.ws.on('message', (raw) => {
      try {
        this._handleMessage(JSON.parse(raw.toString()));
      } catch { /* ignore malformed messages */ }
    });

    this.ws.on('close', () => {
      this.ws = null;
      if (!this._stopped) {
        if (this.onStatusChange) this.onStatusChange('disconnected');
        this._scheduleReconnect();
      }
    });

    this.ws.on('error', () => { /* handled by close */ });
  }

  _handleMessage(msg) {
    const txs = [
      ...(msg['address-transactions'] || []),
      ...(msg['address-removed-transactions'] || []),
    ];
    const triggered = new Set();
    for (const tx of txs) {
      for (const vout of (tx.vout || [])) {
        const addr = vout.scriptpubkey_address;
        if (addr && this.addresses.has(addr) && !triggered.has(addr)) {
          triggered.add(addr);
          this.onActivity(addr);
        }
      }
      for (const vin of (tx.vin || [])) {
        const addr = vin.prevout && vin.prevout.scriptpubkey_address;
        if (addr && this.addresses.has(addr) && !triggered.has(addr)) {
          triggered.add(addr);
          this.onActivity(addr);
        }
      }
    }
  }

  _sendSub() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.addresses.size > 0) {
      this.ws.send(JSON.stringify({ 'track-addresses': [...this.addresses] }));
    }
  }

  _scheduleReconnect() {
    this._reconnectTimer = setTimeout(() => this._connect(), this._reconnectDelay);
    this._reconnectDelay = Math.min(this._reconnectDelay * 2, RECONNECT_MAX_MS);
  }
}

module.exports = AddressMonitor;
