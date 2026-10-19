import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Asset } from '@stellar/stellar-sdk';

import {
  MEMO_TYPES,
  SEP7_URI_LIMIT,
  buildPaymentLink,
  openDeepLink,
  parsePaymentLink,
} from '../src/deeplink.mjs';

const DESTINATION = 'GB3JDWCQJCWMJ3IILWIGDTQJJC5567PGVEVXSCVPEQOTDN64VJBDQBYX';
const ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

function paramsOf(uri) {
  return new URLSearchParams(uri.slice('web+stellar:pay?'.length));
}

test('a native payment link carries destination, amount and network', () => {
  const { uri, warnings } = buildPaymentLink({
    destination: DESTINATION,
    amount: '1.5',
    asset: Asset.native(),
  });

  assert.ok(uri.startsWith('web+stellar:pay?'));
  assert.equal(paramsOf(uri).get('destination'), DESTINATION);
  assert.equal(paramsOf(uri).get('amount'), '1.5');
  assert.equal(paramsOf(uri).get('asset_code'), null);
  assert.equal(paramsOf(uri).get('network_passphrase'), 'Test SDF Network ; September 2015');
  assert.deepEqual(warnings, []);
});

test('a non-native asset link names the code and the issuer', () => {
  const { uri } = buildPaymentLink({
    destination: DESTINATION,
    amount: '25',
    asset: { code: 'USDC', issuer: ISSUER },
  });

  assert.equal(paramsOf(uri).get('asset_code'), 'USDC');
  assert.equal(paramsOf(uri).get('asset_issuer'), ISSUER);
});

test('a memo and a callback are encoded so a & in the text cannot break the link', () => {
  const { uri } = buildPaymentLink({
    destination: DESTINATION,
    amount: '1',
    memo: 'a&b=c#d',
    memoType: 'MEMO_TEXT',
    callback: 'https://example.org/receive?x=1&y=2',
    message: 'invoice & receipt',
  });

  const params = paramsOf(uri);
  assert.equal(params.get('memo'), 'a&b=c#d');
  assert.equal(params.get('memo_type'), 'MEMO_TEXT');
  assert.equal(params.get('callback'), 'https://example.org/receive?x=1&y=2');
  assert.equal(params.get('msg'), 'invoice & receipt');
});

test('a link round-trips through the parser', () => {
  const built = buildPaymentLink({
    destination: DESTINATION,
    amount: '3',
    asset: { code: 'USDC', issuer: ISSUER },
    memo: '42',
    memoType: 'MEMO_ID',
    callback: 'https://example.org/cb',
    message: 'hi',
  });

  assert.deepEqual(parsePaymentLink(built.uri), {
    destination: DESTINATION,
    amount: '3',
    asset: { code: 'USDC', issuer: ISSUER },
    memo: '42',
    memoType: 'MEMO_ID',
    callback: 'https://example.org/cb',
    message: 'hi',
    networkPassphrase: 'Test SDF Network ; September 2015',
  });
});

test('an XLM link parses back as a native asset', () => {
  const { uri } = buildPaymentLink({ destination: DESTINATION, amount: '1' });
  assert.deepEqual(parsePaymentLink(uri).asset, { code: 'XLM', issuer: null });
});

test('bad input is refused with a reason the user can act on', () => {
  assert.throws(() => buildPaymentLink({ amount: '1' }), /valid destination account/);
  assert.throws(() => buildPaymentLink({ destination: 'nope', amount: '1' }), /valid destination/);
  assert.throws(
    () => buildPaymentLink({ destination: DESTINATION, amount: '-1' }),
    /positive decimal/,
  );
  assert.throws(
    () => buildPaymentLink({ destination: DESTINATION, amount: '1', asset: { code: 'USDC' } }),
    /needs an issuer account/,
  );
  assert.throws(
    () => buildPaymentLink({ destination: DESTINATION, memo: 'x', memoType: 'MEMO_POEM' }),
    /Unknown memo type/,
  );
  assert.deepEqual([...MEMO_TYPES], ['MEMO_TEXT', 'MEMO_ID', 'MEMO_HASH', 'MEMO_RETURN']);
});

test('an over-long link is returned with a warning instead of being silently sent', () => {
  const { uri, warnings } = buildPaymentLink({
    destination: DESTINATION,
    amount: '1',
    message: 'x'.repeat(SEP7_URI_LIMIT),
  });

  assert.ok(uri.length > SEP7_URI_LIMIT);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /SEP-7 allows 300/);
});

test('parsing something that is not a payment link is refused', () => {
  assert.throws(() => parsePaymentLink('https://example.org'), /Not a SEP-7 payment link/);
});

test('the handoff prefers the share sheet, then the location, then reports that it could not open', async () => {
  const shared = [];
  const viaShare = await openDeepLink('web+stellar:pay?destination=' + DESTINATION, {
    navigator: { share: async (payload) => shared.push(payload.url) },
  });
  assert.equal(viaShare.opened, 'share');
  assert.equal(shared.length, 1);

  const assigned = [];
  const viaLocation = await openDeepLink('web+stellar:pay?destination=' + DESTINATION, {
    location: { assign: (url) => assigned.push(url) },
  });
  assert.equal(viaLocation.opened, 'location');
  assert.equal(assigned.length, 1);

  const nowhere = await openDeepLink('web+stellar:pay?destination=' + DESTINATION, {});
  assert.equal(nowhere.opened, 'none');
});
