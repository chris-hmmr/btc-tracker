'use strict';

const { HDKey } = require('@scure/bip32');
const { ripemd160 } = require('@noble/hashes/ripemd160');
const { sha256 } = require('@noble/hashes/sha256');
const { bech32, base58check } = require('@scure/base');
const { getAddressInfo } = require('./api');

const b58c = base58check(sha256);

// BIP32 version bytes for mainnet extended public keys
const VERSIONS = {
  xpub: { public: 0x0488b21e, private: 0x0488ade4 }, // P2PKH
  ypub: { public: 0x049d7cb2, private: 0x049d7878 }, // P2SH-P2WPKH
  zpub: { public: 0x04b24746, private: 0x04b2430c }, // P2WPKH (native SegWit)
};

function getVersions(extKey) {
  const prefix = extKey.slice(0, 4).toLowerCase();
  return VERSIONS[prefix] || VERSIONS.xpub;
}

function hash160(bytes) {
  return ripemd160(sha256(bytes));
}

function pubkeyToAddress(pubkey, extKey) {
  const prefix = extKey.slice(0, 4).toLowerCase();
  const h = hash160(pubkey);

  if (prefix === 'zpub') {
    // P2WPKH — bc1q bech32
    const words = bech32.toWords(h);
    return bech32.encode('bc', [0, ...words]);
  }

  if (prefix === 'ypub') {
    // P2SH-P2WPKH — 3... base58check
    const redeemScript = new Uint8Array(22);
    redeemScript[0] = 0x00; // OP_0
    redeemScript[1] = 0x14; // PUSH 20 bytes
    redeemScript.set(h, 2);
    const scriptHash = hash160(redeemScript);
    const payload = new Uint8Array(21);
    payload[0] = 0x05; // P2SH prefix
    payload.set(scriptHash, 1);
    return b58c.encode(payload);
  }

  // P2PKH — 1... base58check (xpub)
  const payload = new Uint8Array(21);
  payload[0] = 0x00; // P2PKH prefix
  payload.set(h, 1);
  return b58c.encode(payload);
}

const GAP_LIMIT = 20;
const REQUEST_DELAY = 1000; // ms between requests — stays well under mempool.space rate limits
const RETRY_DELAYS = [5000, 10000, 20000]; // backoff on rate-limit errors

async function scanXpub(extKey, opts) {
  opts = opts || {};
  const gapLimit = opts.gapLimit || GAP_LIMIT;
  const onProgress = opts.onProgress || null;

  const versions = getVersions(extKey);
  const root = HDKey.fromExtendedKey(extKey, versions);

  let chainFunded = 0;
  let chainSpent = 0;
  let chainTxCount = 0;
  let mempoolFunded = 0;
  let mempoolSpent = 0;
  let mempoolTxCount = 0;

  for (const chain of [0, 1]) { // 0 = receive, 1 = change
    const chainNode = root.deriveChild(chain);
    let index = 0;
    let consecutive = 0;

    while (consecutive < gapLimit) {
      const address = pubkeyToAddress(chainNode.deriveChild(index).publicKey, extKey);

      if (onProgress) {
        onProgress((chain === 0 ? 'recv' : 'chg') + ' #' + index + '…');
      }

      let info = null;
      for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
        try {
          info = await getAddressInfo(address);
          break;
        } catch {
          if (attempt < RETRY_DELAYS.length) {
            if (onProgress) onProgress((chain === 0 ? 'recv' : 'chg') + ' #' + index + ' (retrying…)');
            await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]));
          }
        }
      }

      if (info) {
        const txCount = info.chain_stats.tx_count + info.mempool_stats.tx_count;
        if (txCount === 0) {
          consecutive++;
        } else {
          consecutive = 0;
          chainFunded    += info.chain_stats.funded_txo_sum;
          chainSpent     += info.chain_stats.spent_txo_sum;
          chainTxCount   += info.chain_stats.tx_count;
          mempoolFunded  += info.mempool_stats.funded_txo_sum;
          mempoolSpent   += info.mempool_stats.spent_txo_sum;
          mempoolTxCount += info.mempool_stats.tx_count;
        }
      }
      // If all retries failed, skip without touching consecutive —
      // better to skip one address than to falsely terminate the scan.

      index++;
      await new Promise(r => setTimeout(r, REQUEST_DELAY));
    }
  }

  return {
    chain_stats: {
      funded_txo_sum: chainFunded,
      spent_txo_sum: chainSpent,
      tx_count: chainTxCount,
      funded_txo_count: 0,
      spent_txo_count: 0,
    },
    mempool_stats: {
      funded_txo_sum: mempoolFunded,
      spent_txo_sum: mempoolSpent,
      tx_count: mempoolTxCount,
      funded_txo_count: 0,
      spent_txo_count: 0,
    },
  };
}

function deriveReceiveAddresses(extKey, count) {
  const versions = getVersions(extKey);
  const root = HDKey.fromExtendedKey(extKey, versions);
  const recvNode = root.deriveChild(0);
  const addrs = [];
  for (let i = 0; i < count; i++) {
    addrs.push(pubkeyToAddress(recvNode.deriveChild(i).publicKey, extKey));
  }
  return addrs;
}

module.exports = { scanXpub, pubkeyToAddress, getVersions, deriveReceiveAddresses };
