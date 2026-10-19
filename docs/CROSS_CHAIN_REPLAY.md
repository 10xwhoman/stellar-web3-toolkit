# Cross-Chain Nonce Replay Protection

**Issue:** [#238](https://github.com/Kevin737866/stellar-web3-toolkit/issues/238) — *Cross-chain nonce replay*

A cross-chain transfer is authorised by a signature over one intent: *this sender*,
*this nonce*, *on this chain*, for *this payload*. As soon as a second chain (or a
fork of the same chain) exists, a valid signature on its own is not enough, because
the same bytes can be presented in two different ways:

| Attack | What it looks like | Why the signature does not stop it |
| --- | --- | --- |
| Replay | The settled transfer is submitted again | The signature still verifies |
| Cross-chain replay | A transfer signed for `testnet` is presented to `mainnet` | Only the chain binding distinguishes the two |
| Fork replay | A transfer is re-presented on a fork that shares the signature scheme | Same envelope, different chain instance |

`atomic_swap::replay` implements the countermeasure for all three.

## The two halves of the fix

### 1. The digest names the chain

`domain_separated_digest` hashes:

```
H( "stellar-web3-toolkit/cross-chain-intent/v1"
   ‖ |chain|  ‖ chain
   ‖ |sender| ‖ sender
   ‖ nonce (u64, big-endian)
   ‖ payload (32 bytes) )
```

* The chain id is an **input** to the digest, so a digest produced for one chain
  cannot verify on another. `ReplayGuard::verify_and_record(local_chain, …)`
  recomputes the digest with the *local* chain id and refuses a mismatch with
  `ReplayError::ChainMismatch` **before** it touches the nonce.
* `chain` and `sender` are **length-prefixed**. Without the lengths,
  `("ab", "c")` and `("a", "bc")` would hash identically, and a sender string that
  happens to end in the chain name would let an envelope migrate between chains.
* The `payload` binds the value being moved (amount, recipient, asset, contract
  id — the caller chooses the 32-byte encoding), so a signature cannot be
  repointed at a different transfer.
* Comparison is constant time (`digests_match`), so verification does not leak
  how many leading bytes of a guess were correct.
* `DIGEST_DOMAIN` versions the scheme. Changing it invalidates every previously
  signed intent, which is exactly what you want when the scheme changes.

### 2. The nonce is consumed once per domain

`ReplayGuard::check_and_record(chain, sender, nonce)` consumes the triple exactly
once. The domain is `(chain, sender)`, so:

* a replay returns `ReplayError::Replayed`;
* the *same* nonce from a *different* sender, or on a *different* chain, is a
  different sequence and is accepted — an operator's `mainnet` and `testnet`
  counters are independent, and a shared counter would reject legitimate traffic.

## Why a sliding window instead of a growing set

A "seen nonces" set grows without bound. Each domain instead stores the highest
nonce it accepted plus a 64-bit window of the nonces immediately below it
(`NonceWindow`):

* **Out of order is normal.** Relayers deliver envelopes out of order, so any
  nonce in `[highest - 63, highest]` is accepted once if it was not already seen.
* **Stale is refused.** A nonce below the window cannot be distinguished from a
  replay, so it is refused as `ReplayError::StaleNonce` rather than accepted. The
  window width (`NONCE_WINDOW`, 64) is the size of the reordering tolerance.
* **Too far ahead is refused.** A claimed nonce more than `max_ahead` (default
  `DEFAULT_MAX_AHEAD`, 4096) above the highest accepted is refused as
  `ReplayError::TooFarAhead`, and the window does **not** move. One forged
  envelope therefore cannot wedge a domain by pushing the window past every
  nonce the sender will legitimately use next.
* **Memory is bounded.** The registry tracks at most `max_domains` (default
  `DEFAULT_MAX_DOMAINS`, 4096) domains and refuses new ones with
  `ReplayError::RegistryFull` rather than growing without limit. Operators prune
  closed sequences with `forget(chain, sender)` or
  `forget_domains_below(watermark)`.

## Using it

```rust
use atomic_swap::replay::{CrossChainIntent, ReplayGuard};

let mut guard = ReplayGuard::new();

// The signer approved this intent on testnet.
let intent = CrossChainIntent::new("testnet", "GALICE…", 7)
    .with_payload(payload_digest);
let signature_matches = intent.digest();

// The relayer presents it to testnet: accepted, nonce consumed.
guard.verify_and_record("testnet", &intent, &signature_matches)?;

// Presenting the same envelope to mainnet is refused before the nonce is read.
assert!(guard.verify_and_record("mainnet", &intent, &signature_matches).is_err());

// Presenting it to testnet a second time is a replay.
assert!(guard.verify_and_record("testnet", &intent, &signature_matches).is_err());
```

The coordinator consumes the nonce for a swap at its boundary, through the
optional `SwapRequest::origin_chain` / `SwapRequest::nonce` fields:

```rust
let response = coordinator.initiate_swap(
    initiator,
    SwapRequest {
        // …
        origin_chain: Some("testnet".to_string()),
        nonce: Some(7),
        // …
    },
).await?;
```

* A local swap sets neither field. A cross-chain swap sets **both**: half an
  origin is rejected with `ReplayError::IncompleteIntent` rather than guessed at,
  because guessing wrong either admits a replay or refuses a legitimate transfer.
* The nonce is consumed **before** anything is created, so a replayed envelope is
  refused while the coordinator still has no side effects to undo.
* Multi-hop legs assembled by `create_multi_hop_swap` are internal transfers
  between hop accounts, not cross-chain transfers, so they carry no nonce. The
  nonce belongs to the transfer that entered the route.
* The consumed nonce stays recorded even if the swap later fails: a nonce, once
  presented, is spent.

## Observability

`ReplayGuard::stats()` returns a `ReplayStats` snapshot: `accepted`, `replayed`,
`stale`, `too_far_ahead`, `chain_mismatch` and `domains_tracked`, reachable from
the coordinator as `replay_stats()`. Alert on `replayed`, `chain_mismatch` and
`too_far_ahead` — none of them can be triggered by honest traffic.

## Runbook

| Symptom | Meaning | Action |
| --- | --- | --- |
| `Replayed` for a known sender | Someone re-presented an envelope, or a relayer retried after settlement | Confirm the original transfer settled; if it did not, the retry is legitimate and belongs on a *new* nonce |
| `ChainMismatch` | An intent signed for another chain was presented here | Treat as hostile: check the relayer's chain configuration (network passphrase) first |
| `TooFarAhead` | The sender's nonce jumped past `max_ahead`, or a forged envelope | Confirm the sender did not reset its sequence; the window is unchanged, so no nonce was spent |
| `StaleNonce` | A nonce older than the 64-wide window | The sender is behind: reconcile its sequence, or raise `NONCE_WINDOW` if deliveries legitimately lag that far |
| `RegistryFull` | More than 4096 live `(chain, sender)` domains | Prune closed sequences with `forget_domains_below`, or raise `DEFAULT_MAX_DOMAINS` deliberately |
| `IncompleteIntent` | A caller set only one of `origin_chain` / `nonce` | Fix the caller; the guard refuses to guess |

## Tests

`cargo test -p atomic-swap` covers the module and its integration:

* digest binding to chain, sender, nonce and payload; length-prefix ambiguity;
* forged-digest rejection that leaves the nonce unconsumed;
* monotonic, out-of-order, stale, far-ahead and replayed nonces;
* independent domains per chain and per sender;
* registry capacity, and `forget` / `forget_domains_below` pruning;
* coordinator integration: a cross-chain nonce is consumed exactly once, the
  replay creates no swap, and a half-declared origin is refused.
