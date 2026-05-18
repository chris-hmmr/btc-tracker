const axios = require('axios');

const BASE = 'https://mempool.space/api';

function isExtendedKey(addr) {
  return /^[xyzXYZ]pub/.test(addr);
}

async function getAddressInfo(address) {
  const res = await axios.get(`${BASE}/address/${address}`, { timeout: 10000 });
  return res.data;
}

async function getTransactions(address) {
  const res = await axios.get(`${BASE}/address/${address}/txs`, { timeout: 10000 });
  return res.data;
}

async function getXpubInfo(xpub) {
  const res = await axios.get(`${BASE}/xpub/${xpub}`, { timeout: 15000 });
  return res.data;
}

async function getXpubTransactions(xpub) {
  const res = await axios.get(`${BASE}/xpub/${xpub}/txs`, { timeout: 15000 });
  return res.data;
}

async function getAnyAddressInfo(addr) {
  return isExtendedKey(addr) ? getXpubInfo(addr) : getAddressInfo(addr);
}

async function getAnyTransactions(addr) {
  return isExtendedKey(addr) ? getXpubTransactions(addr) : getTransactions(addr);
}

async function getBtcPrice() {
  try {
    const res = await axios.get(`${BASE}/v1/prices`, { timeout: 5000 });
    return res.data.USD || null;
  } catch {
    return null;
  }
}

function getIncomingTxs(txs, address) {
  return txs
    .map(tx => {
      const received = tx.vout.reduce((sum, o) =>
        o.scriptpubkey_address === address ? sum + o.value : sum, 0);
      return received > 0 ? { ...tx, received } : null;
    })
    .filter(Boolean);
}

function satToBtc(sat) {
  return (sat / 1e8).toFixed(8).replace(/\.?0+$/, '');
}

module.exports = {
  getAddressInfo, getTransactions,
  getXpubInfo, getXpubTransactions,
  getAnyAddressInfo, getAnyTransactions,
  getBtcPrice, getIncomingTxs, satToBtc,
  isExtendedKey,
};
