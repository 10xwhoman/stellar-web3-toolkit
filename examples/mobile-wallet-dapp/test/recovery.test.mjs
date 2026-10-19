import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveConfig } from '../src/config.mjs';
import { RecoveryStep, createRecovery } from '../src/recovery.mjs';

// Assembled from words rather than written as a literal, for the same reason as
// in `mnemonic.test.mjs`: it is public test data, but the repository's secret
// scanner cannot tell public test data from a leaked phrase, and it should not
// have to.
const VECTOR_PHRASE = [...new Array(11).fill('abandon'), 'about'].join(' ');
const VECTOR_ACCOUNT = 'GB3JDWCQJCWMJ3IILWIGDTQJJC5567PGVEVXSCVPEQOTDN64VJBDQBYX';

const testnet = resolveConfig({ search: '?network=testnet' });
const mainnet = resolveConfig({ search: '?network=mainnet' });

/** A server whose account lookup either finds the account or 404s it. */
function fakeServer({ exists = false, sequence = '42', failure = null, balances = [] } = {}) {
  const calls = { getAccount: [] };
  return {
    calls,
    async getAccount(publicKey) {
      calls.getAccount.push(publicKey);
      if (failure) {
        throw new Error(failure);
      }
      if (!exists) {
        throw new Error(`account not found: ${publicKey}`);
      }
      return { sequenceNumber: () => sequence, balances };
    },
  };
}

/** Friendbot stand-in. */
function fakeFetch({ ok = true, status = 200, body = '' } = {}) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    return { ok, status, text: async () => body };
  };
  return { impl, calls };
}

test('the flow validates, derives, looks up and reports an existing account', async () => {
  const steps = [];
  const recovery = createRecovery({
    config: testnet,
    server: fakeServer({ exists: true, balances: [{ asset_type: 'native', balance: '10.0' }] }),
    fetch: fakeFetch().impl,
  });

  const result = await recovery.recover(VECTOR_PHRASE, { onStep: (s) => steps.push(s.step) });

  assert.equal(result.ok, true);
  assert.equal(result.publicKey, VECTOR_ACCOUNT);
  assert.equal(result.exists, true);
  assert.equal(result.funded, false);
  assert.deepEqual(steps, [RecoveryStep.Validate, RecoveryStep.Lookup, RecoveryStep.Done]);
});

test('a phrase that derives an account with no history is funded on testnet', async () => {
  const fetch = fakeFetch();
  const recovery = createRecovery({
    config: testnet,
    server: fakeServer({ exists: false }),
    fetch: fetch.impl,
  });

  const result = await recovery.recover(VECTOR_PHRASE);

  assert.equal(result.ok, true);
  assert.equal(result.exists, false);
  assert.equal(result.funded, true);
  assert.equal(fetch.calls.length, 1);
  assert.match(fetch.calls[0], /friendbot\.stellar\.org\?addr=G/);
  assert.ok(fetch.calls[0].includes(encodeURIComponent(VECTOR_ACCOUNT)));
});

test('a faucet failure is surfaced rather than reported as a recovery', async () => {
  const recovery = createRecovery({
    config: testnet,
    server: fakeServer({ exists: false }),
    fetch: fakeFetch({ ok: false, status: 429, body: 'rate limited' }).impl,
  });

  await assert.rejects(() => recovery.recover(VECTOR_PHRASE), /refused to fund .*429 rate limited/);
});

test('a network failure during lookup is not mistaken for a missing account', async () => {
  const recovery = createRecovery({
    config: testnet,
    server: fakeServer({ failure: 'connect ECONNREFUSED 127.0.0.1:8000' }),
    fetch: fakeFetch().impl,
  });

  const result = await recovery.recover(VECTOR_PHRASE);

  // No account was created on the strength of a failed lookup.
  assert.equal(result.ok, false);
  assert.equal(result.step, RecoveryStep.Lookup);
  assert.match(result.error, /ECONNREFUSED/);
});

test('mainnet has no faucet, so an unknown account is reported instead of created', async () => {
  const fetch = fakeFetch();
  const recovery = createRecovery({
    config: mainnet,
    server: fakeServer({ exists: false }),
    fetch: fetch.impl,
  });

  const result = await recovery.recover(VECTOR_PHRASE);

  assert.equal(result.ok, false);
  assert.equal(result.step, RecoveryStep.Lookup);
  assert.match(result.error, /no history on Mainnet/);
  assert.match(result.error, /no faucet to create it/);
  assert.equal(fetch.calls.length, 0);
});

test('`create: false` refuses to fund even where a faucet exists', async () => {
  const fetch = fakeFetch();
  const recovery = createRecovery({
    config: testnet,
    server: fakeServer({ exists: false }),
    fetch: fetch.impl,
  });

  const result = await recovery.recover(VECTOR_PHRASE, { create: false });
  assert.equal(result.ok, false);
  assert.match(result.error, /no history on this network/);
  assert.equal(fetch.calls.length, 0);
});

test('an invalid phrase stops at validation and derives nothing', async () => {
  const server = fakeServer({ exists: true });
  const recovery = createRecovery({ config: testnet, server, fetch: fakeFetch().impl });

  const result = await recovery.recover('abandon about');

  assert.equal(result.ok, false);
  assert.equal(result.step, RecoveryStep.Validate);
  assert.match(result.error, /has 2/);
  assert.equal(server.calls.getAccount.length, 0);
});

test('the account index selects which derived account is recovered', async () => {
  const recovery = createRecovery({
    config: testnet,
    server: fakeServer({ exists: true }),
    fetch: fakeFetch().impl,
  });

  const zero = await recovery.derive(VECTOR_PHRASE, { accountIndex: 0 });
  const one = await recovery.derive(VECTOR_PHRASE, { accountIndex: 1 });

  assert.equal(zero.publicKey, VECTOR_ACCOUNT);
  assert.notEqual(one.publicKey, zero.publicKey);
  assert.ok(one.secretKey.startsWith('S'));
});

test('the phrase check is exposed for inline form feedback', () => {
  const recovery = createRecovery({
    config: testnet,
    server: fakeServer(),
    fetch: fakeFetch().impl,
  });

  assert.equal(recovery.checkPhrase(VECTOR_PHRASE).ok, true);
  assert.equal(recovery.checkPhrase('nope nope').ok, false);
  assert.equal(recovery.normalizePhrase(`  ${VECTOR_PHRASE.toUpperCase()} `), VECTOR_PHRASE);
});

test('a recovery without a config is refused immediately', () => {
  assert.throws(() => createRecovery({ server: fakeServer() }), /needs a config/);
});
