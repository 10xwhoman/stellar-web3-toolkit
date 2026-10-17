import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  Account,
  Address,
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from '@stellar/stellar-sdk';

import { resolveConfig } from '../src/config.mjs';
import {
  WalletError,
  assertAuthEntriesSigned,
  createWallet,
  describeAuthEntries,
  isAccountId,
  isContractId,
  toScVal,
  validateAmount,
} from '../src/wallet.mjs';

const config = resolveConfig({ search: '', env: {} });
const SOURCE = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(1));
const DESTINATION = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(2));
const CONTRACT = 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE';

/** An `rpc.Server` stand-in that records what it was asked and replays a script. */
function fakeServer({
  account = new Account(SOURCE.publicKey(), '7'),
  transactionResults = [{ status: 'SUCCESS' }],
  send = { status: 'PENDING', hash: 'abc123' },
  simulation,
} = {}) {
  const calls = { prepared: [], sent: [], polled: [] };
  let index = 0;
  return {
    calls,
    async getAccount(publicKey) {
      assert.equal(publicKey, SOURCE.publicKey());
      return account;
    },
    async prepareTransaction(transaction) {
      calls.prepared.push(transaction);
      return transaction;
    },
    async sendTransaction(envelopeXdr) {
      calls.sent.push(envelopeXdr);
      return send;
    },
    async getTransaction(hash) {
      calls.polled.push(hash);
      const result = transactionResults[Math.min(index, transactionResults.length - 1)];
      index += 1;
      return result;
    },
    async simulateTransaction() {
      return simulation ?? { result: { retval: nativeToScVal(1000n, { type: 'i128' }) } };
    },
  };
}

/** A wallet adapter that signs with a real local keypair. */
function fakeProvider(keypair = SOURCE) {
  const calls = { requested: 0, signed: [] };
  return {
    calls,
    name: 'fake',
    async requestAccess() {
      calls.requested += 1;
      return keypair.publicKey();
    },
    async getAddress() {
      return keypair.publicKey();
    },
    async signTransaction(xdrString, options) {
      calls.signed.push(options);
      const tx = TransactionBuilder.fromXDR(xdrString, options.networkPassphrase);
      tx.sign(keypair);
      return tx.toXDR();
    },
  };
}

test('amounts are validated before they reach a transaction', () => {
  assert.equal(validateAmount('1.5'), '1.5');
  assert.equal(validateAmount(2), '2');
  assert.equal(validateAmount('0.0000001'), '0.0000001');

  assert.throws(() => validateAmount(''), /Enter an amount/);
  assert.throws(() => validateAmount('1e3'), /positive number/);
  assert.throws(() => validateAmount('-4'), /positive number/);
  assert.throws(() => validateAmount('0'), /greater than zero/);
  assert.throws(() => validateAmount('1.12345678'), /at most 7 decimal places/);
});

test('a payment is built for the configured network with the right destination and amount', async () => {
  const server = fakeServer();
  const wallet = createWallet({ config, server, provider: fakeProvider() });

  const transaction = await wallet.buildPayment({
    from: SOURCE.publicKey(),
    to: DESTINATION.publicKey(),
    amount: '2.5',
    memo: 'invoice 42',
  });

  assert.equal(transaction.networkPassphrase, Networks.TESTNET);
  assert.equal(transaction.source, SOURCE.publicKey());
  assert.equal(new TextDecoder().decode(transaction.memo.value), 'invoice 42');
  const operation = transaction.operations[0];
  assert.equal(operation.type, 'payment');
  assert.equal(operation.destination, DESTINATION.publicKey());
  // The SDK renders amounts at full precision: 7 decimal places.
  assert.equal(operation.amount, '2.5000000');
  assert.equal(operation.asset.isNative(), true);
});

test('a payment to a bad destination is refused before any network call', async () => {
  const server = fakeServer();
  const wallet = createWallet({ config, server, provider: fakeProvider() });
  await assert.rejects(
    () => wallet.buildPayment({ from: SOURCE.publicKey(), to: 'nope', amount: '1' }),
    /Destination is not a Stellar account/,
  );
  assert.equal(server.calls.prepared.length, 0);
});

test('a custom asset is carried into the operation', async () => {
  const server = fakeServer();
  const wallet = createWallet({ config, server, provider: fakeProvider() });
  const asset = new Asset('USDC', 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5');

  const transaction = await wallet.buildPayment({
    from: SOURCE.publicKey(),
    to: DESTINATION.publicKey(),
    amount: '10',
    asset,
  });

  const operation = transaction.operations[0];
  assert.equal(operation.asset.getCode(), 'USDC');
  assert.equal(operation.asset.getIssuer(), asset.getIssuer());
  assert.equal(operation.asset.isNative(), false);
});

test('a contract call is built with the method and ScVal arguments', async () => {
  const server = fakeServer();
  const wallet = createWallet({ config, server, provider: fakeProvider() });

  const transaction = await wallet.buildContractCall({
    from: SOURCE.publicKey(),
    contractId: CONTRACT,
    method: 'deposit',
    args: [SOURCE.publicKey(), 1_000_000n],
  });

  const [operation] = transaction.operations;
  assert.equal(operation.type, 'invokeHostFunction');
  assert.equal(operation.func.type, 'hostFunctionTypeInvokeContract');
  const invocation = operation.func.invokeContract;
  assert.equal(new TextDecoder().decode(invocation.functionName.bytes), 'deposit');
  assert.equal(invocation.args.length, 2);
  assert.equal(Address.fromScAddress(invocation.contractAddress).toString(), CONTRACT);
  // No auth entries yet: the host decides what has to be authorized, which is
  // exactly why `prepareTransaction` exists.
  assert.equal(operation.auth?.length ?? 0, 0);
  assert.deepEqual(wallet.authEntries(transaction), []);
});

test('argument conversion is explicit about types', () => {
  assert.equal(toScVal(SOURCE.publicKey()).type, 'scvAddress');
  assert.equal(toScVal(CONTRACT).type, 'scvAddress');
  assert.equal(toScVal(42n).type, 'scvI128');
  assert.equal(toScVal(42).type, 'scvI128');
  assert.equal(toScVal('hello').type, 'scvString');
  assert.equal(toScVal({ type: 'u32', value: 7 }).type, 'scvU32');
  // An address-shaped string that is not a valid account is text, not an
  // address, because the SDK would refuse to encode it as one.
  assert.equal(toScVal('G'.padEnd(56, 'A')).type, 'scvString');
  assert.throws(() => toScVal({ nested: true }), /pass \{ type, value \} explicitly/);
});

test('a contract call with a malformed contract id never reaches the network', async () => {
  const server = fakeServer();
  const wallet = createWallet({ config, server, provider: fakeProvider() });
  await assert.rejects(
    () => wallet.buildContractCall({ from: SOURCE.publicKey(), contractId: 'G'.repeat(56), method: 'x' }),
    /Not a contract id/,
  );
  assert.equal(server.calls.prepared.length, 0);
});

test('reads are simulated and decoded, never signed', async () => {
  const server = fakeServer();
  const provider = fakeProvider();
  const wallet = createWallet({ config, server, provider });

  const value = await wallet.readContract({
    from: SOURCE.publicKey(),
    contractId: CONTRACT,
    method: 'balance_of',
    args: [SOURCE.publicKey()],
  });

  assert.equal(value, 1000n);
  assert.equal(provider.calls.signed.length, 0);
  assert.equal(server.calls.sent.length, 0);
});

test('a failed simulation is reported as an error rather than a value', async () => {
  const server = fakeServer({ simulation: { error: 'host trapped: balance overflow' } });
  const wallet = createWallet({ config, server, provider: fakeProvider() });
  await assert.rejects(
    () => wallet.readContract({ from: SOURCE.publicKey(), contractId: CONTRACT, method: 'balance_of' }),
    /Simulation failed: host trapped/,
  );
});

test('a payment is signed by the wallet, submitted and confirmed', async () => {
  const server = fakeServer();
  const provider = fakeProvider();
  const wallet = createWallet({ config, server, provider, sleep: async () => {} });

  const result = await wallet.sendPayment({
    from: SOURCE.publicKey(),
    to: DESTINATION.publicKey(),
    amount: '1',
  });

  assert.equal(result.hash, 'abc123');
  assert.equal(result.status, 'SUCCESS');
  assert.equal(provider.calls.signed.length, 1);
  assert.equal(provider.calls.signed[0].networkPassphrase, Networks.TESTNET);
  assert.equal(server.calls.sent.length, 1);

  // The submitted envelope must be the signed one: check the signature count.
  const submitted = TransactionBuilder.fromXDR(server.calls.sent[0], Networks.TESTNET);
  assert.equal(submitted.signatures.length, 1);
});

test('a contract write is prepared by the RPC before it is signed', async () => {
  const server = fakeServer();
  const provider = fakeProvider();
  const wallet = createWallet({ config, server, provider, sleep: async () => {} });

  await wallet.invokeContract({
    from: SOURCE.publicKey(),
    contractId: CONTRACT,
    method: 'deposit',
    args: [SOURCE.publicKey(), 5n],
  });

  assert.equal(server.calls.prepared.length, 1);
  assert.equal(server.calls.prepared[0].operations[0].type, 'invokeHostFunction');
  assert.equal(provider.calls.signed.length, 1);
});

test('a rejected transaction is reported, not retried silently', async () => {
  const server = fakeServer({ send: { status: 'ERROR', hash: 'deadbeef', errorResult: { code: -1 } } });
  const wallet = createWallet({ config, server, provider: fakeProvider(), sleep: async () => {} });
  await assert.rejects(
    () => wallet.sendPayment({ from: SOURCE.publicKey(), to: DESTINATION.publicKey(), amount: '1' }),
    /network rejected the transaction/,
  );
});

test('a transaction that never lands gives up and names the hash', async () => {
  const server = fakeServer({ transactionResults: [{ status: 'NOT_FOUND' }] });
  const wallet = createWallet({
    config,
    server,
    provider: fakeProvider(),
    sleep: async () => {},
    confirmAttempts: 3,
  });
  await assert.rejects(
    () => wallet.sendPayment({ from: SOURCE.publicKey(), to: DESTINATION.publicKey(), amount: '1' }),
    /abc123 was not in a ledger after 3 checks/,
  );
  assert.equal(server.calls.polled.length, 3);
});

test('polling keeps checking until the ledger includes the transaction', async () => {
  const server = fakeServer({
    transactionResults: [{ status: 'NOT_FOUND' }, { status: 'NOT_FOUND' }, { status: 'SUCCESS' }],
  });
  const wallet = createWallet({ config, server, provider: fakeProvider(), sleep: async () => {} });
  const result = await wallet.sendPayment({
    from: SOURCE.publicKey(),
    to: DESTINATION.publicKey(),
    amount: '1',
  });
  assert.equal(result.status, 'SUCCESS');
  assert.equal(server.calls.polled.length, 3);
});

test('a transaction that fails in the ledger is surfaced as an error', async () => {
  const server = fakeServer({ transactionResults: [{ status: 'FAILED', resultXdr: 'AAAA' }] });
  const wallet = createWallet({ config, server, provider: fakeProvider(), sleep: async () => {} });
  await assert.rejects(
    () => wallet.sendPayment({ from: SOURCE.publicKey(), to: DESTINATION.publicKey(), amount: '1' }),
    /failed in the ledger/,
  );
});

test('connecting is refused without a provider, and validated with one', async () => {
  const server = fakeServer();
  const bare = createWallet({ config, server });
  await assert.rejects(() => bare.connect(), /No wallet connected yet/);

  const wallet = createWallet({ config, server, provider: fakeProvider(DESTINATION) });
  assert.equal(await wallet.connect(), DESTINATION.publicKey());
  assert.equal(await wallet.address(), DESTINATION.publicKey());
});

test('a wallet that returns an unusable address is refused', async () => {
  const server = fakeServer();
  const wallet = createWallet({
    config,
    server,
    provider: { async requestAccess() { return '0xdeadbeef'; } },
  });
  await assert.rejects(() => wallet.connect(), /unusable address/);
});

test('authorization-entry counting treats source-account credentials as already authorized', () => {
  const signed = { requiresSignature: true, signature: { value: () => [1] } };
  const unsigned = { requiresSignature: true, signature: { value: () => [] } };
  const sourceAccount = { requiresSignature: false, signature: null };

  assert.deepEqual(describeAuthEntries([signed, sourceAccount]), {
    total: 2,
    requiresSignature: 1,
    signed: 1,
    unsigned: 0,
  });
  assert.deepEqual(describeAuthEntries([unsigned, sourceAccount]), {
    total: 2,
    requiresSignature: 1,
    signed: 0,
    unsigned: 1,
  });
  assert.deepEqual(describeAuthEntries([]), {
    total: 0,
    requiresSignature: 0,
    signed: 0,
    unsigned: 0,
  });
});

/**
 * A Soroban transaction carrying one address-credential authorization entry.
 *
 * Hand-built because the real thing only appears after `prepareTransaction`
 * asks a live host for a footprint; this is the shape a wallet that does not
 * sign auth entries hands back, and it is what the guard has to catch.
 */
function sorobanTxWithAuthEntry({ signature }) {
  const invocationArgs = new xdr.InvokeContractArgs({
    contractAddress: Address.fromString(CONTRACT).toScAddress(),
    functionName: 'deposit',
    args: [],
  });
  const authEntry = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: Address.fromString(SOURCE.publicKey()).toScAddress(),
        nonce: 1n,
        signatureExpirationLedger: 999,
        signature,
      }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function:
        xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(invocationArgs),
      subInvocations: [],
    }),
  });

  const account = new Account(SOURCE.publicKey(), '1');
  const builder = new TransactionBuilder(account, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.invokeHostFunction({
        func: xdr.HostFunction.hostFunctionTypeInvokeContract(invocationArgs),
        auth: [authEntry],
      }),
    )
    .setTimeout(30);
  const transaction = builder.build();
  transaction.sign(SOURCE);
  return transaction;
}

test('a signed envelope whose auth entries are still empty is refused with an explanation', () => {
  const unsigned = sorobanTxWithAuthEntry({ signature: xdr.ScVal.scvVec([]) });
  assert.throws(
    () => assertAuthEntriesSigned(unsigned.toXDR(), Networks.TESTNET),
    /1 of 1 Soroban authorization entry came back unsigned/,
  );

  const signedEntry = xdr.ScVal.scvVec([xdr.ScVal.scvBytes(new Uint8Array([1, 2, 3]))]);
  const signed = sorobanTxWithAuthEntry({ signature: signedEntry });
  assert.deepEqual(assertAuthEntriesSigned(signed.toXDR(), Networks.TESTNET), {
    total: 1,
    requiresSignature: 1,
    signed: 1,
    unsigned: 0,
  });
});

test('an envelope with no host-function operations has nothing to check', () => {
  const account = new Account(SOURCE.publicKey(), '1');
  const payment = new TransactionBuilder(account, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: DESTINATION.publicKey(),
        asset: Asset.native(),
        amount: '1',
      }),
    )
    .setTimeout(30)
    .build();
  payment.sign(SOURCE);

  assert.deepEqual(assertAuthEntriesSigned(payment.toXDR(), Networks.TESTNET), {
    total: 0,
    requiresSignature: 0,
    signed: 0,
    unsigned: 0,
  });
  assert.throws(
    () => assertAuthEntriesSigned('not-an-envelope', Networks.TESTNET),
    /Could not read the signed transaction/,
  );
});

test('account and contract id validation is honest about both shapes', () => {
  assert.equal(isAccountId(SOURCE.publicKey()), true);
  assert.equal(isAccountId(CONTRACT), false);
  assert.equal(isContractId(CONTRACT), true);
  assert.equal(isContractId(SOURCE.publicKey()), false);
  assert.equal(isAccountId(undefined), false);
});

test('a wallet error is recognisable', async () => {
  const server = fakeServer();
  const wallet = createWallet({ config, server, provider: fakeProvider() });
  await assert.rejects(
    () => wallet.buildPayment({ from: 'nope', to: DESTINATION.publicKey(), amount: '1' }),
    (error) => error instanceof WalletError,
  );
});
