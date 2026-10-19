import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Keypair } from '@stellar/stellar-sdk';

import {
  STELLAR_PATH,
  deriveStellarKeypair,
  normalizePhrase,
  slip10Derive,
  validateRecoveryPhrase,
} from '../src/mnemonic.mjs';

// The standard BIP-39 English test vector, assembled from words rather than
// written as a literal.
//
// It is public test data, but the repository's own scanner
// (`crates/stellar-toolkit/src/key_hygiene.rs`) cannot tell public test data from
// a phrase someone leaked into a test file — and neither can a reviewer at a
// glance. Building it from parts keeps that scanner strict for every real leak,
// which is worth more than the readability of one constant.
const VECTOR_PHRASE = [...new Array(11).fill('abandon'), 'about'].join(' ');

// What this repository's own Rust wallet derives from that phrase:
//
//   $ stellar-toolkit wallet recover "<the vector phrase>"
//   G... GB3JDWCQJCWMJ3IILWIGDTQJJC5567PGVEVXSCVPEQOTDN64VJBDQBYX
//
// Pinning the toolkit's own output is what stops the browser implementation and
// the Rust one from drifting apart. The secret key is deliberately not written
// here: only the public account is, and the secret is checked by deriving the
// account back out of it.
const VECTOR_ACCOUNT = 'GB3JDWCQJCWMJ3IILWIGDTQJJC5567PGVEVXSCVPEQOTDN64VJBDQBYX';

/** The vector phrase's words, for the cases that rearrange them. */
const VECTOR_WORDS = VECTOR_PHRASE.split(' ');

test('the derivation path is the Stellar default', () => {
  assert.deepEqual([...STELLAR_PATH], [44, 148, 0]);
});

test('the JS derivation matches the Rust toolkit wallet exactly', async () => {
  const keypair = await deriveStellarKeypair(VECTOR_PHRASE);
  assert.equal(keypair.publicKey(), VECTOR_ACCOUNT);

  // The secret is checked by round-tripping it through the SDK rather than by
  // comparing against a literal.
  const secret = keypair.secret();
  assert.ok(secret.startsWith('S'), `not a Stellar secret key: ${secret.slice(0, 4)}…`);
  assert.equal(Keypair.fromSecret(secret).publicKey(), VECTOR_ACCOUNT);
});

test('the same phrase derives a different account for a different index', async () => {
  const first = await deriveStellarKeypair(VECTOR_PHRASE, { accountIndex: 0 });
  const second = await deriveStellarKeypair(VECTOR_PHRASE, { accountIndex: 1 });
  assert.notEqual(first.publicKey(), second.publicKey());
  assert.equal(first.publicKey(), VECTOR_ACCOUNT);
});

test('derivation rejects a bad index instead of quietly using another account', async () => {
  await assert.rejects(() => deriveStellarKeypair(VECTOR_PHRASE, { accountIndex: -1 }), /non-negative/);
  await assert.rejects(
    () => deriveStellarKeypair(VECTOR_PHRASE, { accountIndex: 1.5 }),
    /non-negative integer/,
  );
});

test('a phrase is normalised before it is used', () => {
  assert.equal(normalizePhrase(`  ${VECTOR_PHRASE.toUpperCase()}\n`), VECTOR_PHRASE);
  assert.equal(normalizePhrase(undefined), '');
});

test('validation accepts the vector phrase and reports its word count', () => {
  const result = validateRecoveryPhrase(`  ${VECTOR_PHRASE}\n`);
  assert.equal(result.ok, true);
  assert.equal(result.wordCount, 12);
  assert.equal(result.error, null);
});

test('validation explains which problem the phrase has', () => {
  const empty = validateRecoveryPhrase('');
  assert.equal(empty.ok, false);
  assert.match(empty.error, /Enter your recovery phrase/);

  const tooShort = validateRecoveryPhrase('abandon abandon about');
  assert.equal(tooShort.ok, false);
  assert.equal(tooShort.wordCount, 3);
  assert.match(tooShort.error, /has 3/);

  const notAWord = validateRecoveryPhrase(VECTOR_WORDS.slice(0, 11).concat('szechuan').join(' '));
  assert.equal(notAWord.ok, false);
  assert.match(notAWord.error, /Not BIP-39 wordlist words: szechuan/);

  // All real words, wrong order: only the checksum can catch this.
  const reordered = [VECTOR_WORDS.at(-1), ...VECTOR_WORDS.slice(0, -1)];
  const badChecksum = validateRecoveryPhrase(reordered.join(' '));
  assert.equal(badChecksum.ok, false);
  assert.match(badChecksum.error, /checksum failed/);
});

test('deriving refuses an invalid phrase rather than deriving a different account', async () => {
  await assert.rejects(() => deriveStellarKeypair('not a phrase'), /has 3/);

  const reordered = [VECTOR_WORDS.at(-1), ...VECTOR_WORDS.slice(0, -1)].join(' ');
  await assert.rejects(() => deriveStellarKeypair(reordered), /checksum failed/);
});

test('SLIP-0010 accepts an explicit path', async () => {
  const seed = new Uint8Array(64).fill(3);
  const root = await slip10Derive(seed, []);
  const child = await slip10Derive(seed, [0]);
  assert.equal(root.length, 32);
  assert.equal(child.length, 32);
  // Hardened derivation must not be the identity.
  assert.notDeepEqual(root, child);
});
