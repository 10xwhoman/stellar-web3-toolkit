//! SEP-7 deep links: the handoff that makes this example work on a phone.
//!
//! A mobile browser has no extension wallet, so a dapp cannot ask for a
//! signature directly. What it can do is hand the payment to a wallet app that
//! the operating system opens for it: a `web+stellar:` URI that names the
//! destination, the amount, the asset and where to send the result back. The
//! wallet signs and submits; the dapp never sees a key.
//!
//! The format is SEP-7 (`web+stellar:pay?…`). Two details are easy to get wrong
//! and are handled here: the URI is capped at 300 characters by the SEP (a
//! longer one is silently dropped by some wallets), and every value has to be
//! URL-encoded, because an asset issuer or a memo can contain `&` or `#`.

import { Asset, StrKey } from '@stellar/stellar-sdk';

/** SEP-7 caps the whole URI: longer ones are dropped by some wallets. */
export const SEP7_URI_LIMIT = 300;

/** Memo types a `pay` operation link may carry. */
export const MEMO_TYPES = Object.freeze(['MEMO_TEXT', 'MEMO_ID', 'MEMO_HASH', 'MEMO_RETURN']);

/**
 * Build a `web+stellar:pay` link for a mobile wallet.
 *
 * Returns `{ uri, warnings }` rather than throwing on the soft failures: a link
 * that is merely long is still usable, and the caller (the UI) is the only place
 * that knows whether to show it with a warning or to trim the memo.
 */
export function buildPaymentLink({
  destination,
  amount,
  asset,
  memo,
  memoType,
  callback,
  message,
  networkPassphrase,
} = {}) {
  if (!StrKey.isValidEd25519PublicKey(String(destination ?? ''))) {
    throw new Error('A SEP-7 payment link needs a valid destination account (G...).');
  }

  const params = new URLSearchParams();
  params.set('destination', destination);

  if (amount !== undefined) {
    const text = String(amount).trim();
    if (!/^\d+(\.\d+)?$/.test(text) || Number(text) <= 0) {
      throw new Error(`Amount must be a positive decimal, got ${JSON.stringify(amount)}.`);
    }
    params.set('amount', text);
  }

  if (asset && !isNative(asset)) {
    if (!StrKey.isValidEd25519PublicKey(String(asset.issuer ?? ''))) {
      throw new Error('A non-native asset needs an issuer account (G...).');
    }
    params.set('asset_code', asset.code);
    params.set('asset_issuer', asset.issuer);
  }

  if (memo !== undefined) {
    const type = memoType ?? 'MEMO_TEXT';
    if (!MEMO_TYPES.includes(type)) {
      throw new Error(`Unknown memo type ${JSON.stringify(memoType)}; expected ${MEMO_TYPES.join(', ')}.`);
    }
    params.set('memo', String(memo));
    params.set('memo_type', type);
  }

  if (callback) {
    params.set('callback', String(callback));
  }
  if (message) {
    params.set('msg', String(message));
  }
  // Keeps the link honest for a wallet that supports several networks.
  params.set('network_passphrase', networkPassphrase ?? 'Test SDF Network ; September 2015');

  const uri = `web+stellar:pay?${params.toString()}`;
  const warnings = [];
  if (uri.length > SEP7_URI_LIMIT) {
    warnings.push(
      `The link is ${uri.length} characters; SEP-7 allows ${SEP7_URI_LIMIT} and some wallets drop anything longer. Shorten the message or the callback.`,
    );
  }
  return { uri, warnings };
}

function isNative(asset) {
  if (typeof asset === 'string') {
    return asset === 'native' || asset === 'XLM';
  }
  if (asset instanceof Asset) {
    return asset.isNative();
  }
  return false;
}

/**
 * Parse a SEP-7 `pay` link back into its fields.
 *
 * Round-tripping matters for the tests and for the callback path: a wallet that
 * returns a signed XDR usually echoes the same parameters.
 */
export function parsePaymentLink(uri) {
  const text = String(uri ?? '');
  if (!text.startsWith('web+stellar:pay?')) {
    throw new Error('Not a SEP-7 payment link.');
  }
  const params = new URLSearchParams(text.slice('web+stellar:pay?'.length));
  const assetCode = params.get('asset_code');
  const assetIssuer = params.get('asset_issuer');
  return {
    destination: params.get('destination'),
    amount: params.get('amount') ?? undefined,
    asset:
      assetCode && assetIssuer ? { code: assetCode, issuer: assetIssuer } : { code: 'XLM', issuer: null },
    memo: params.get('memo') ?? undefined,
    memoType: params.get('memo_type') ?? undefined,
    callback: params.get('callback') ?? undefined,
    message: params.get('msg') ?? undefined,
    networkPassphrase: params.get('network_passphrase') ?? undefined,
  };
}

/**
 * Hand the link to the operating system, choosing the best mechanism available.
 *
 * `share` (Web Share API) is preferred on mobile — it shows the wallet apps
 * installed on the device. `location.assign` is the fallback, and in a test
 * environment (no window) the caller is told which URL would have been opened.
 */
export async function openDeepLink(uri, { navigator: nav, location } = {}) {
  if (nav?.share) {
    await nav.share({ url: uri });
    return { opened: 'share', uri };
  }
  if (location?.assign) {
    location.assign(uri);
    return { opened: 'location', uri };
  }
  return { opened: 'none', uri };
}
