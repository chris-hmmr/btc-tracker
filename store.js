const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA_DIR = path.join(os.homedir(), '.btc-tracker');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const LOG_FILE = path.join(DATA_DIR, 'tracker.log');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadState() {
  ensureDir();
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (!raw.addressBook) raw.addressBook = [];
    return raw;
  } catch {
    return { seenTxIds: [], addresses: {}, addressBook: [] };
  }
}

function saveState(state) {
  ensureDir();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function log(message) {
  ensureDir();
  const line = `[${new Date().toISOString()}] ${message}\n`;
  fs.appendFileSync(LOG_FILE, line);
}

function addAddress(address, label) {
  const state = loadState();
  if (state.addressBook.some(e => e.address === address)) return false;
  const shortLabel = address.length > 20
    ? address.slice(0, 10) + '…' + address.slice(-6)
    : address;
  state.addressBook.push({ address, label: label || shortLabel, addedAt: Date.now() });
  saveState(state);
  return true;
}

function removeAddress(address) {
  const state = loadState();
  const before = state.addressBook.length;
  state.addressBook = state.addressBook.filter(e => e.address !== address);
  if (state.addressBook.length < before) {
    saveState(state);
    return true;
  }
  return false;
}

function getAddressBook() {
  return loadState().addressBook;
}

function getLogPath() { return LOG_FILE; }
function getDataDir() { return DATA_DIR; }

module.exports = {
  loadState, saveState, log,
  addAddress, removeAddress, getAddressBook,
  getLogPath, getDataDir,
};
