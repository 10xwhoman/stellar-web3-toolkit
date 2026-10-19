//! Network and contract configuration for the example (issue #128).
//!
//! Everything a deployment needs to point the dapp at a different network or a
//! different set of contracts lives here, so the UI code never hard-codes a URL
//! or a contract id.

import { Networks } from '@stellar/stellar-sdk';

/** Networks this example knows how to talk to. */
export const NETWORKS = Object.freeze({
  testnet: Object.freeze({
    name: 'testnet',
    label: 'Testnet',
    rpcUrl: 'https://soroban-testnet.stellar.org',
    horizonUrl: 'https://horizon-testnet.stellar.org',
    passphrase: Networks.TESTNET,
    // Friendbot only exists on testnet; recovery uses it to create the account
    // a recovered phrase derives to. `null` means "cannot fund here".
    friendbotUrl: 'https://friendbot.stellar.org',
  }),
  mainnet: Object.freeze({
    name: 'mainnet',
    label: 'Mainnet',
    rpcUrl: 'https://mainnet.sorobanrpc.com',
    horizonUrl: 'https://horizon.stellar.org',
    passphrase: Networks.PUBLIC,
    friendbotUrl: null,
  }),
});

/** Default network when nothing is specified. */
export const DEFAULT_NETWORK = 'testnet';

/**
 * Contract ids to wire the wallet to.
 *
 * These are placeholders on purpose: a contract id is deployment-specific, and
 * a hard-coded one would silently point the example at someone else's contract.
 * Set them via `?contract=<C...>` in the URL, or here for a deployment.
 */
export const DEFAULT_CONTRACT_IDS = Object.freeze({
  /** `contracts/token-locker` — `deposit`, `balance_of`, `withdraw`. */
  tokenLocker: '',
  /** `contracts/amm-pool` — `swap`, `get_reserves`. */
  ammPool: '',
});

/**
 * Resolve the runtime configuration.
 *
 * `?network=mainnet` and `?contract=<C...>` let the example be pointed at a
 * deployment without a rebuild; an unknown network is refused rather than
 * defaulted, because silently talking to the wrong chain is how a testnet dapp
 * ends up spending real value.
 */
export function resolveConfig({
  search = '',
  env = {},
  contracts = DEFAULT_CONTRACT_IDS,
} = {}) {
  const params = new URLSearchParams(search);
  const requested = params.get('network') ?? env.STELLAR_NETWORK ?? DEFAULT_NETWORK;
  const network = NETWORKS[requested];
  if (!network) {
    throw new Error(
      `unknown network ${JSON.stringify(requested)}; expected one of ${Object.keys(NETWORKS).join(', ')}`,
    );
  }

  const contractOverride = params.get('contract');
  const rpcUrl = params.get('rpc') ?? env.STELLAR_RPC_URL ?? network.rpcUrl;
  const horizonUrl = params.get('horizon') ?? env.STELLAR_HORIZON_URL ?? network.horizonUrl;

  return Object.freeze({
    ...network,
    rpcUrl,
    horizonUrl,
    contracts: Object.freeze({
      ...contracts,
      ...(contractOverride ? { tokenLocker: contractOverride } : {}),
    }),
  });
}

/**
 * The contract id to wire to, or a helpful error.
 *
 * The error carries the fix (where to set the id), because an empty contract id
 * otherwise surfaces as an opaque XDR parse failure several layers down.
 */
export function requireContractId(config, name = 'tokenLocker') {
  const id = config.contracts[name];
  if (!id) {
    throw new Error(
      `no contract id configured for "${name}": deploy a contract, then open the dapp with ?contract=<C...> or set it in src/config.mjs`,
    );
  }
  return id;
}
