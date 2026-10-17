//! UI wiring for `index.html`.
//!
//! All of the interesting logic lives in the modules next to this one; this file
//! only moves values between the DOM and them, and renders what comes back. The
//! split is what makes the flows testable under `node --test` with no browser.

import { Asset, rpc } from '@stellar/stellar-sdk';
import { requireContractId, resolveConfig } from './config.mjs';
import { buildPaymentLink, openDeepLink } from './deeplink.mjs';
import { createRecovery } from './recovery.mjs';
import { createWallet, freighterProvider, isAccountId } from './wallet.mjs';

const config = resolveConfig({ search: window.location.search });
const server = new rpc.Server(config.rpcUrl);

const el = (id) => document.getElementById(id);

const state = {
  address: null,
  wallet: null,
};

function log(message, kind = 'info') {
  const out = el('log');
  const line = document.createElement('div');
  line.className = `log-line log-${kind}`;
  line.textContent = message;
  out.prepend(line);
}

function setNetworkBadge() {
  el('network').textContent = `${config.label} · ${config.rpcUrl.replace('https://', '')}`;
}

async function connect() {
  try {
    const provider = await freighterProvider();
    const wallet = createWallet({ config, server, provider });
    state.address = await wallet.connect();
    state.wallet = wallet;
    el('address').textContent = state.address;
    log(`Connected ${state.address}`, 'ok');
    await refreshBalance();
  } catch (error) {
    log(error.message, 'error');
  }
}

async function refreshBalance() {
  if (!state.address) {
    log('Connect a wallet first.', 'error');
    return;
  }
  try {
    const account = await server.getAccount(state.address);
    const native = account.balances?.find?.((b) => b.asset_type === 'native');
    el('balance').textContent = native ? `${native.balance} XLM` : 'no XLM balance';
  } catch (error) {
    log(`Could not load the account: ${error.message}`, 'error');
  }
}

async function sendPayment() {
  try {
    const to = el('pay-destination').value.trim();
    const amount = el('pay-amount').value.trim();
    const memo = el('pay-memo').value.trim();
    const result = await state.wallet.sendPayment({
      from: state.address,
      to,
      amount,
      memo: memo || undefined,
    });
    log(`Payment confirmed in ${result.hash}`, 'ok');
    await refreshBalance();
  } catch (error) {
    log(error.message, 'error');
  }
}

function buildDeepLink() {
  try {
    const { uri, warnings } = buildPaymentLink({
      destination: el('pay-destination').value.trim(),
      amount: el('pay-amount').value.trim(),
      asset: Asset.native(),
      memo: el('pay-memo').value.trim() || undefined,
      message: 'Payment from the mobile wallet dapp example',
      networkPassphrase: config.passphrase,
    });
    el('deeplink').textContent = uri;
    for (const warning of warnings) {
      log(warning, 'error');
    }
    log('Deep link ready: share it, or open it on a phone to hand the payment to a wallet app.', 'ok');
  } catch (error) {
    log(error.message, 'error');
  }
}

async function openDeepLinkOnDevice() {
  const uri = el('deeplink').textContent;
  if (!uri.startsWith('web+stellar:')) {
    log('Build the link first.', 'error');
    return;
  }
  const opened = await openDeepLink(uri, { navigator: window.navigator, location: window.location });
  log(opened.opened === 'none' ? `Open this on a phone: ${uri}` : `Handed to the wallet via ${opened.opened}.`);
}

/// "GABC…,1000,note" → the argument list `toScVal` understands.
function parseArgs() {
  return el('contract-args')
    .value.split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      if (isAccountId(part) || part.startsWith('C')) {
        return part;
      }
      return /^-?\d+$/.test(part) ? BigInt(part) : part;
    });
}

async function readContractField() {
  try {
    const contractId = el('contract-id').value.trim() || requireContractId(config, 'tokenLocker');
    const method = el('contract-method').value.trim();
    const value = await state.wallet.readContract({
      from: state.address,
      contractId,
      method,
      args: parseArgs(),
    });
    log(`${method}() → ${formatValue(value)}`, 'ok');
  } catch (error) {
    log(error.message, 'error');
  }
}

async function invokeContract() {
  try {
    const contractId = el('contract-id').value.trim() || requireContractId(config, 'tokenLocker');
    const method = el('contract-method').value.trim();
    const args = parseArgs();
    log(`Submitting ${method}() — confirm in your wallet.`);
    const result = await state.wallet.invokeContract({
      from: state.address,
      contractId,
      method,
      args,
    });
    log(`${method}() confirmed in ${result.hash} (${formatValue(result.returnValue)})`, 'ok');
  } catch (error) {
    log(error.message, 'error');
  }
}

function formatValue(value) {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

async function recover() {
  try {
    const recovery = createRecovery({ config, server });
    const phrase = el('recovery-phrase').value;
    const accountIndex = Number(el('recovery-index').value || 0);
    const result = await recovery.recover(phrase, {
      accountIndex,
      create: config.friendbotUrl !== null,
      onStep: (step) => {
        if (step.step !== 'derive') {
          log(`recovery: ${step.step}`);
        }
      },
    });

    if (!result.ok) {
      log(result.error, 'error');
      return;
    }
    el('recovery-account').textContent = result.publicKey;
    log(
      result.exists
        ? `Recovered ${result.publicKey}: the account exists on ${config.label}.`
        : `Recovered ${result.publicKey} and created it with the faucet.`,
      'ok',
    );
    log(
      'The secret key is shown below so it can be written down. This example keeps it in memory only — a real deployment should hand phrase handling to the wallet app.',
    );
    el('recovery-secret').textContent = result.secretKey;
  } catch (error) {
    log(error.message, 'error');
  }
}

function wire() {
  setNetworkBadge();
  el('connect').addEventListener('click', connect);
  el('refresh').addEventListener('click', refreshBalance);
  el('pay-send').addEventListener('click', sendPayment);
  el('deeplink-build').addEventListener('click', buildDeepLink);
  el('deeplink-open').addEventListener('click', openDeepLinkOnDevice);
  el('contract-read').addEventListener('click', readContractField);
  el('contract-invoke').addEventListener('click', invokeContract);
  el('recovery-run').addEventListener('click', recover);
}

if (typeof document !== 'undefined') {
  wire();
}

export { config, state, server };
