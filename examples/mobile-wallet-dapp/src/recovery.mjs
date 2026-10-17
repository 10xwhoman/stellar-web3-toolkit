//! Recovery UX: getting a user back into their account on a new device.
//!
//! "Recovery" here means the whole path, not just deriving a key:
//!
//! 1. **Validate the phrase** before deriving anything, and say *which* problem
//!    it has (word count, unknown word, checksum) because those need different
//!    fixes.
//! 2. **Derive the account** with the same BIP-39 + SLIP-0010 the toolkit's Rust
//!    wallet uses, so the browser and `stellar-toolkit wallet recover` agree.
//! 3. **Find out whether the account exists** on the network. A phrase that
//!    derives a funded account is a recovery; one that derives an empty account
//!    is a phrase for an account that was never created (or the wrong phrase).
//! 4. **Offer to create it** — on testnet only, with Friendbot. This is the step
//!    that turns a dead end into a working account, and the step that is
//!    deliberately refused on mainnet.
//!
//! The derived secret never leaves this module's caller: it is returned for the
//! user to write down, and nothing here persists, logs or transmits it.

import { deriveStellarKeypair, normalizePhrase, validateRecoveryPhrase } from './mnemonic.mjs';

/** What each step of the recovery flow is doing. */
export const RecoveryStep = Object.freeze({
  Validate: 'validate',
  Derive: 'derive',
  Lookup: 'lookup',
  Fund: 'fund',
  Done: 'done',
});

/**
 * Build the recovery flow.
 *
 * `server` needs `getAccount` (an `rpc.Server`, or a fake); `fetch` is injected
 * so Friendbot can be stubbed in tests.
 */
export function createRecovery({
  config,
  server,
  fetch: fetchImpl = globalThis.fetch,
  friendbotUrl = config?.friendbotUrl ?? null,
} = {}) {
  if (!config) {
    throw new Error('createRecovery needs a config (see resolveConfig).');
  }

  /** Step 1: is this a phrase at all? */
  function checkPhrase(phrase) {
    return validateRecoveryPhrase(phrase);
  }

  /** Steps 1–2: validate, then derive the account the phrase controls. */
  async function derive(phrase, { accountIndex = 0 } = {}) {
    const check = checkPhrase(phrase);
    if (!check.ok) {
      return { ok: false, step: RecoveryStep.Validate, error: check.error, wordCount: check.wordCount };
    }
    const keypair = await deriveStellarKeypair(phrase, { accountIndex });
    return {
      ok: true,
      step: RecoveryStep.Derive,
      accountIndex,
      publicKey: keypair.publicKey(),
      secretKey: keypair.secret(),
    };
  }

  /** Step 3: does the account exist on the network? */
  async function lookup(publicKey) {
    try {
      const account = await server.getAccount(publicKey);
      return { exists: true, sequence: account.sequenceNumber?.() ?? account.sequence ?? null };
    } catch (error) {
      // The RPC reports a missing account the same way it reports a broken
      // connection, so the distinction is made on the error text rather than
      // assumed to be "not found".
      const message = String(error?.message ?? error);
      const missing = /not found|does not exist|account not found|404/i.test(message);
      return { exists: false, missing, error: missing ? null : message };
    }
  }

  /** Step 4: create the account on testnet using Friendbot. */
  async function fund(publicKey) {
    if (!friendbotUrl) {
      throw new Error(
        `This network (${config.name}) has no faucet, so an account that does not exist cannot be created here. Fund ${publicKey} from somewhere else and try again.`,
      );
    }
    if (typeof fetchImpl !== 'function') {
      throw new Error('No fetch implementation available to reach the faucet.');
    }
    const response = await fetchImpl(`${friendbotUrl}?addr=${encodeURIComponent(publicKey)}`);
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`The faucet refused to fund ${publicKey}: ${response.status} ${body}`.trim());
    }
    return { funded: true, url: `${friendbotUrl}?addr=${publicKey}` };
  }

  /**
   * Run the whole flow, reporting each step as it happens.
   *
   * `onStep` is how the UI narrates progress; `create` decides whether a missing
   * account is created (testnet) or reported (mainnet).
   */
  async function recover(phrase, { accountIndex = 0, create = true, onStep = () => {} } = {}) {
    onStep({ step: RecoveryStep.Validate });
    const derived = await derive(phrase, { accountIndex });
    if (!derived.ok) {
      return derived;
    }

    onStep({ step: RecoveryStep.Lookup, publicKey: derived.publicKey });
    const looked = await lookup(derived.publicKey);
    if (!looked.exists && looked.error) {
      return { ...derived, ok: false, step: RecoveryStep.Lookup, error: looked.error };
    }

    let funded = false;
    if (!looked.exists) {
      // No account and no way to make one: that is a dead end with an
      // explanation, not a crash. Mainnet has no faucet, so it always lands
      // here rather than throwing from `fund`.
      if (!create || !friendbotUrl) {
        return {
          ...derived,
          ok: false,
          step: RecoveryStep.Lookup,
          exists: false,
          error: friendbotUrl
            ? 'That phrase derives an account that has no history on this network. Check the phrase and the account index before creating anything.'
            : `That phrase derives an account with no history on ${config.label}, and ${config.label} has no faucet to create it. Check the phrase and the account index.`,
        };
      }

      onStep({ step: RecoveryStep.Fund, publicKey: derived.publicKey });
      await fund(derived.publicKey);
      funded = true;
    }

    onStep({ step: RecoveryStep.Done, publicKey: derived.publicKey });
    return { ...derived, ok: true, step: RecoveryStep.Done, exists: looked.exists, funded };
  }

  return { checkPhrase, derive, lookup, fund, recover, normalizePhrase, config };
}
