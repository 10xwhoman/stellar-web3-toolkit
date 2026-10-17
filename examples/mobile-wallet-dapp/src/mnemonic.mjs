//! Recovery-phrase handling: BIP-39 validation and SLIP-0010 derivation.
//!
//! This mirrors `crates/stellar-toolkit/src/wallet.rs` exactly — BIP-39 with an
//! empty passphrase, then SLIP-0010 hardened-only ed25519 derivation at
//! `m/44'/148'/index'` — so a phrase recovered in the browser derives the same
//! account as `stellar-toolkit wallet recover "<phrase>"`. `test/mnemonic.test.mjs`
//! pins that agreement with the toolkit's own output for the standard
//! `abandon … about` vector, which is the only thing stopping the two
//! implementations from drifting apart silently.
//!
//! HMAC-SHA512 comes from Web Crypto rather than a Node built-in, so the exact
//! same module runs in the browser and under `node --test`.

import { Keypair } from '@stellar/stellar-sdk';
import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

/** Hardened derivation path Stellar wallets use by default. */
export const STELLAR_PATH = Object.freeze([44, 148, 0]);

/** Word counts BIP-39 allows (entropy 128…256 bits). */
export const VALID_WORD_COUNTS = Object.freeze([12, 15, 18, 21, 24]);

const textEncoder = new TextEncoder();

/** `phrase` with its whitespace and case normalised, as BIP-39 requires. */
export function normalizePhrase(phrase) {
  return String(phrase ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/**
 * Check a phrase before deriving anything from it.
 *
 * Returns `{ ok, wordCount, error }` rather than throwing: the recovery form
 * shows the reason inline as the user types, and the reason has to distinguish
 * "wrong number of words" from "one word is not in the wordlist" from "the
 * checksum failed", because those need different fixes.
 */
export function validateRecoveryPhrase(phrase) {
  const normalized = normalizePhrase(phrase);
  const words = normalized.length === 0 ? [] : normalized.split(' ');

  if (words.length === 0) {
    return { ok: false, wordCount: 0, error: 'Enter your recovery phrase.' };
  }
  if (!VALID_WORD_COUNTS.includes(words.length)) {
    return {
      ok: false,
      wordCount: words.length,
      error: `A recovery phrase has ${VALID_WORD_COUNTS.join(', ')} words; this one has ${words.length}.`,
    };
  }
  const unknown = words.filter((word) => !wordlist.includes(word));
  if (unknown.length > 0) {
    return {
      ok: false,
      wordCount: words.length,
      error: `Not BIP-39 wordlist words: ${unknown.join(', ')}`,
    };
  }
  if (!validateMnemonic(normalized, wordlist)) {
    return {
      ok: false,
      wordCount: words.length,
      error: 'The words are all valid but the checksum failed — check the order and the spelling.',
    };
  }
  return { ok: true, wordCount: words.length, error: null };
}

/** HMAC-SHA512, via Web Crypto so browser and Node run the same code. */
async function hmacSha512(keyBytes, dataBytes) {
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-512' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, dataBytes));
}

/**
 * SLIP-0010 hardened-only ed25519 derivation.
 *
 * Ed25519 has no non-hardened derivation, so every index is hardened and the
 * chain is `HMAC-SHA512(chain_code, 0x00 ‖ private_key ‖ ser32(index + 2³¹))`.
 */
export async function slip10Derive(seed, path = STELLAR_PATH) {
  let digest = await hmacSha512(textEncoder.encode('ed25519 seed'), seed);
  let privateKey = digest.slice(0, 32);
  let chainCode = digest.slice(32);

  for (const index of path) {
    const data = new Uint8Array(1 + 32 + 4);
    data[0] = 0x00;
    data.set(privateKey, 1);
    new DataView(data.buffer).setUint32(33, (index | 0x80000000) >>> 0, false);
    digest = await hmacSha512(chainCode, data);
    privateKey = digest.slice(0, 32);
    chainCode = digest.slice(32);
  }

  return privateKey;
}

/**
 * Derive the Stellar keypair a recovery phrase controls.
 *
 * `accountIndex` becomes the last path element (`m/44'/148'/accountIndex'`), so
 * a user with several accounts from one phrase can pick the one they mean.
 */
export async function deriveStellarKeypair(phrase, { accountIndex = 0 } = {}) {
  const normalized = normalizePhrase(phrase);
  const check = validateRecoveryPhrase(normalized);
  if (!check.ok) {
    throw new Error(check.error);
  }
  if (!Number.isInteger(accountIndex) || accountIndex < 0) {
    throw new Error(`account index must be a non-negative integer, got ${accountIndex}`);
  }

  const seed = mnemonicToSeedSync(normalized);
  const secret = await slip10Derive(seed, [44, 148, accountIndex]);
  return Keypair.fromRawEd25519Seed(secret);
}
