//! Wallet connection, transaction building, signing and contract calls.
//!
//! Three rules shape this module:
//!
//! 1. **The wallet owns the key.** Signing is a call to the wallet's provider,
//!    never something this code does with a secret it holds. The recovery flow
//!    is the one place a secret is derived, and it deliberately does not route
//!    through here.
//! 2. **Every network call is injected.** `server`, `provider`, `sleep` and the
//!    friendbot `fetch` are parameters, so the same code that runs in a browser
//!    runs under `node --test` against fakes with no network and no extension.
//! 3. **A prepared Soroban transaction is not a signed one.** `prepareTransaction`
//!    fills in the footprint and the authorization entries the *host* demands;
//!    who signs them is the wallet's business, and if it returns an envelope
//!    whose authorization entries are still empty the call is refused with an
//!    explanation instead of being submitted and failing on-chain.

import {
  Account,
  Asset,
  BASE_FEE,
  Contract,
  Memo,
  Operation,
  StrKey,
  TimeoutInfinite,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
} from '@stellar/stellar-sdk';

/** Anything the example refuses to do, with a message meant for the user. */
export class WalletError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WalletError';
  }
}

/** Ledgers to wait for a submitted transaction before giving up. */
export const DEFAULT_CONFIRM_ATTEMPTS = 20;
export const DEFAULT_CONFIRM_INTERVAL_MS = 1_000;
export const DEFAULT_TRANSACTION_TIMEOUT = TimeoutInfinite;

const STROOPS_PER_UNIT = 10_000_000;

/** True when `value` is a Stellar public key (`G...`). */
export function isAccountId(value) {
  return typeof value === 'string' && StrKey.isValidEd25519PublicKey(value);
}

/** True when `value` is a contract id (`C...`). */
export function isContractId(value) {
  return typeof value === 'string' && StrKey.isValidContract(value);
}

/**
 * Validate a user-entered amount.
 *
 * Returns the amount as a string, which is what the SDK takes: rounding a
 * stroop-denominated amount through a float is how a 0.0000001 difference
 * becomes a failed transaction.
 */
export function validateAmount(amount) {
  const text = String(amount ?? '').trim();
  if (text.length === 0) {
    throw new WalletError('Enter an amount.');
  }
  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw new WalletError(`Amount must be a positive number, got ${JSON.stringify(text)}.`);
  }
  const [whole, fraction = ''] = text.split('.');
  if (fraction.length > 7) {
    throw new WalletError(
      `Stellar amounts have at most 7 decimal places; ${text} has ${fraction.length}.`,
    );
  }
  const stroops = BigInt(whole) * BigInt(STROOPS_PER_UNIT) + BigInt(fraction.padEnd(7, '0') || '0');
  if (stroops <= 0n) {
    throw new WalletError('Amount must be greater than zero.');
  }
  return text;
}

/**
 * Count the Soroban authorization entries and how many still need a signature.
 *
 * Pure over descriptors, so the rule is unit-testable without hand-building XDR
 * envelopes. An entry whose credentials are the *source account* is authorized
 * by the transaction signature itself and needs nothing extra, which is why
 * `requiresSignature: false` entries never count as unsigned.
 */
export function describeAuthEntries(entries = []) {
  const list = [...entries];
  const required = list.filter((entry) => entry.requiresSignature !== false);
  const unsigned = required.filter((entry) => !hasSignature(entry.signature));
  return {
    total: list.length,
    requiresSignature: required.length,
    signed: required.length - unsigned.length,
    unsigned: unsigned.length,
  };
}

/** An `scvVec` with items is a signature; an empty one, or nothing, is not. */
function hasSignature(signature) {
  if (signature === undefined || signature === null) {
    return false;
  }
  const value = read(signature, 'value');
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (value !== undefined && value !== null) {
    return Boolean(value);
  }
  return true;
}

/**
 * Read an XDR field.
 *
 * The SDK's generated XDR types have used both `field` and `field()` across
 * versions, and this module has to read envelopes produced by whichever one the
 * caller installed. Reading through one helper keeps that variance in one
 * place instead of at every field access.
 */
function read(object, field) {
  if (object === undefined || object === null) {
    return undefined;
  }
  const property = object[field];
  return typeof property === 'function' ? property.call(object) : property;
}

/**
 * Descriptors for the authorization entries of a transaction's host-function
 * operations. An unprepared transaction has none; a prepared one may have
 * several, and the caller has to know whether the wallet signed them.
 */
export function authEntryDescriptors(transaction) {
  const operations = read(transaction, 'operations') ?? [];
  return operations
    .filter((operation) => read(operation, 'type') === 'invokeHostFunction')
    .flatMap((operation) => (read(operation, 'auth') ?? []).map(describeCredential));
}

function describeCredential(entry) {
  const credentials = read(entry, 'credentials');
  const addressCredentials = read(credentials, 'address');
  if (!addressCredentials) {
    // `sorobanCredentialsSourceAccount`: the transaction signature authorizes
    // it, so an empty entry signature is not a problem to report.
    return { requiresSignature: false, signature: null };
  }
  return { requiresSignature: true, signature: read(addressCredentials, 'signature') };
}

/**
 * Refuse a signed envelope whose authorization entries are still empty.
 *
 * This is the check that turns "the transaction failed on-chain, figure out
 * why" into a sentence naming the wallet capability that is missing.
 */
export function assertAuthEntriesSigned(signedEnvelopeXdr, networkPassphrase) {
  let status;
  try {
    const transaction = TransactionBuilder.fromXDR(signedEnvelopeXdr, networkPassphrase);
    status = describeAuthEntries(authEntryDescriptors(transaction));
  } catch (error) {
    // An envelope this code cannot read is one it cannot vouch for, but the
    // failure is reported as what it is rather than as a signing problem.
    throw new WalletError(`Could not read the signed transaction: ${error.message}`);
  }

  if (status.unsigned > 0) {
    throw new WalletError(
      `${status.unsigned} of ${status.requiresSignature} Soroban authorization entr${status.requiresSignature === 1 ? 'y' : 'ies'} came back unsigned. ` +
        'This contract call needs a wallet that signs authorization entries (Freighter and most mobile wallets do this inside signTransaction; a wallet that exposes signAuthEntry separately should be asked for it explicitly).',
    );
  }
  return status;
}

/**
 * The browser-extension provider (Freighter), adapted to the interface the rest
 * of this module uses.
 *
 * Loaded lazily so the module can be imported in a browser without the
 * extension, in Node without a DOM, and in tests without either.
 */
export async function freighterProvider() {
  let api;
  try {
    const module = await import('@stellar/freighter-api');
    api = module.default ?? module;
  } catch (error) {
    throw new WalletError(
      `No wallet provider available in this context (${error.message}). On a phone, use the deep-link handoff instead: it opens the wallet app directly.`,
    );
  }

  const unwrap = (result, what) => {
    if (result && typeof result === 'object' && 'error' in result && result.error) {
      throw new WalletError(`${what} failed: ${result.error.message ?? result.error}`);
    }
    return result;
  };

  return {
    name: 'freighter',
    async requestAccess() {
      const result = unwrap(await api.requestAccess(), 'Connecting to Freighter');
      return typeof result === 'string' ? result : (result.address ?? result.publicKey);
    },
    async getAddress() {
      const result = unwrap(await api.getAddress(), 'Reading the wallet address');
      return typeof result === 'string' ? result : result.address;
    },
    async signTransaction(xdr, options) {
      const result = unwrap(await api.signTransaction(xdr, options), 'Signing');
      return typeof result === 'string' ? result : (result.signedTxXdr ?? result.signedXDR);
    },
    signAuthEntry:
      typeof api.signAuthEntry === 'function'
        ? async (entryXdr, options) => {
            const result = unwrap(await api.signAuthEntry(entryXdr, options), 'Signing auth entry');
            return typeof result === 'string'
              ? result
              : (result.signedAuthEntry ?? result.signedEntry);
          }
        : undefined,
  };
}

/**
 * The wallet-facing half of the dapp.
 *
 * `server` is an `rpc.Server` (or anything with the same methods) and
 * `provider` is the wallet adapter above; both are parameters so a test can
 * supply fakes that assert what was built and what was signed.
 */
export function createWallet({
  config,
  server = new rpc.Server(config.rpcUrl),
  provider,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  confirmAttempts = DEFAULT_CONFIRM_ATTEMPTS,
  confirmIntervalMs = DEFAULT_CONFIRM_INTERVAL_MS,
} = {}) {
  if (!config) {
    throw new WalletError('createWallet needs a config (see resolveConfig).');
  }

  const requireProvider = () => {
    if (!provider) {
      throw new WalletError('No wallet connected yet.');
    }
    return provider;
  };

  /** Build a payment that the connected wallet can sign. */
  async function buildPayment({ from, to, amount, asset = Asset.native(), memo, timeout } = {}) {
    if (!isAccountId(from)) {
      throw new WalletError(`Source is not a Stellar account: ${JSON.stringify(from)}`);
    }
    if (!isAccountId(to)) {
      throw new WalletError(`Destination is not a Stellar account: ${JSON.stringify(to)}`);
    }
    const account = await server.getAccount(from);
    let builder = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: config.passphrase,
    })
      .addOperation(
        Operation.payment({ destination: to, asset, amount: validateAmount(amount) }),
      )
      .setTimeout(timeout ?? DEFAULT_TRANSACTION_TIMEOUT);
    if (memo) {
      builder = builder.addMemo(Memo.text(String(memo).slice(0, 28)));
    }
    return builder.build();
  }

  /** Build a contract call, before the host's footprint and auth are known. */
  async function buildContractCall({ from, contractId, method, args = [], timeout } = {}) {
    if (!isAccountId(from)) {
      throw new WalletError(`Source is not a Stellar account: ${JSON.stringify(from)}`);
    }
    if (!isContractId(contractId)) {
      throw new WalletError(`Not a contract id: ${JSON.stringify(contractId)}`);
    }
    if (!method) {
      throw new WalletError('A contract call needs a method name.');
    }
    const account = await server.getAccount(from);
    const contract = new Contract(contractId);
    return new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: config.passphrase,
    })
      .addOperation(contract.call(method, ...args.map(toScVal)))
      .setTimeout(timeout ?? DEFAULT_TRANSACTION_TIMEOUT)
      .build();
  }

  /** Read a contract value: simulate, never sign, never submit. */
  async function readContract({ from, contractId, method, args = [] } = {}) {
    const transaction = await buildContractCall({ from, contractId, method, args });
    const simulation = await server.simulateTransaction(transaction);
    if (simulation.error) {
      throw new WalletError(`Simulation failed: ${simulation.error}`);
    }
    return scValToNative(simulation.result.retval);
  }

  /** Ask the wallet to sign an envelope, and check what came back. */
  async function signTransaction(transaction, { address } = {}) {
    const wallet = requireProvider();
    const signed = await wallet.signTransaction(transaction.toXDR(), {
      networkPassphrase: config.passphrase,
      address,
    });
    if (typeof signed !== 'string' || signed.length === 0) {
      throw new WalletError('The wallet returned no signed transaction.');
    }
    assertAuthEntriesSigned(signed, config.passphrase);
    return signed;
  }

  /** Submit a signed envelope and wait for the ledger that includes it. */
  async function submitAndConfirm(signedEnvelopeXdr) {
    const sent = await server.sendTransaction(signedEnvelopeXdr);
    if (sent.status === 'ERROR' || sent.errorResult) {
      throw new WalletError(
        `The network rejected the transaction${sent.errorResult ? `: ${JSON.stringify(sent.errorResult)}` : ''}`,
      );
    }
    return confirm(sent.hash);
  }

  /** Poll until the transaction is in a ledger, or give up with the hash. */
  async function confirm(hash) {
    for (let attempt = 0; attempt < confirmAttempts; attempt += 1) {
      const result = await server.getTransaction(hash);
      if (result.status === 'SUCCESS') {
        return { hash, status: result.status, returnValue: decodeReturnValue(result) };
      }
      if (result.status === 'FAILED') {
        throw new WalletError(`Transaction ${hash} failed in the ledger: ${result.resultXdr ?? 'no result'}`);
      }
      await sleep(confirmIntervalMs);
    }
    throw new WalletError(
      `Transaction ${hash} was not in a ledger after ${confirmAttempts} checks; it may still land. Check the hash before resubmitting.`,
    );
  }

  return {
    config,
    server,
    /** Connect the wallet and return its address. */
    async connect() {
      const address = await requireProvider().requestAccess();
      if (!isAccountId(address)) {
        throw new WalletError(`The wallet returned an unusable address: ${JSON.stringify(address)}`);
      }
      return address;
    },
    /** The address the wallet is already authorised for, if any. */
    async address() {
      const wallet = requireProvider();
      if (typeof wallet.getAddress !== 'function') {
        return null;
      }
      const address = await wallet.getAddress();
      return isAccountId(address) ? address : null;
    },
    buildPayment,
    buildContractCall,
    readContract,
    signTransaction,
    authEntries: authEntryDescriptors,
    assertAuthEntriesSigned,
    submitAndConfirm,
    confirm,
    /** Payment: build, sign, submit, confirm. */
    async sendPayment({ from, ...rest }) {
      const transaction = await buildPayment({ from, ...rest });
      const signed = await signTransaction(transaction, { address: from });
      return submitAndConfirm(signed);
    },
    /** Contract write: build, prepare, sign, submit, confirm. */
    async invokeContract({ from, contractId, method, args = [] }) {
      const built = await buildContractCall({ from, contractId, method, args });
      const prepared = await server.prepareTransaction(built);
      const signed = await signTransaction(prepared, { address: from });
      return submitAndConfirm(signed);
    },
  };
}

/**
 * JS value → ScVal, the way the toolkit's contracts expect arguments.
 *
 * Numbers and bigints are `i128`, which is what every amount in this workspace
 * is; anything ambiguous (a `u32` ledger, a `bytes` payload) has to say so:
 * `{ type: 'u32', value: 1234 }`.
 */
export function toScVal(value) {
  if (value && typeof value === 'object' && 'type' in value && 'value' in value) {
    return nativeToScVal(value.value, { type: value.type });
  }
  if (typeof value === 'bigint' || typeof value === 'number') {
    return nativeToScVal(value, { type: 'i128' });
  }
  if (typeof value === 'string') {
    // Both a `G...` account and a `C...` contract address are `address`
    // arguments; anything else is text unless the caller says otherwise.
    return isAccountId(value) || isContractId(value)
      ? nativeToScVal(value, { type: 'address' })
      : nativeToScVal(value, { type: 'string' });
  }
  throw new WalletError(
    `Cannot convert ${JSON.stringify(value)} to a contract argument; pass { type, value } explicitly.`,
  );
}

function decodeReturnValue(result) {
  try {
    return result.returnValue ? scValToNative(result.returnValue) : undefined;
  } catch {
    return undefined;
  }
}
