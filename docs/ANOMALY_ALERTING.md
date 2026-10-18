# Alerting for Anomalous On-Chain Activity

**Issue:** [#124](https://github.com/Kevin737866/stellar-web3-toolkit/issues/124) — *Add alerting for anomalous on-chain activity*

**Runs in:** `stellar-toolkit monitoring anomalies --input <window.json>` (CI: the
`automated-checks` job) and as the `stellar-anomalies` rule group in
`monitoring/alert-rules.yml` (Prometheus + Alertmanager).

A fixed threshold cannot see the attacks that matter most here, because the
attack is a deviation from *that contract's own* normal, not a number above some
line someone guessed. A contract doing 40 invocations a minute that suddenly does
40 000 is being drained; a contract that always does 40 000 is just busy. Judging
both against the same constant leaves the honest one alarm-fatigued and the
draining one unnoticed.

So every rule compares the newest sample with the metric's own recent baseline.

## How a sample is scored

```text
z = (observed - median) / dispersion
dispersion = max(1.4826 × MAD, max(min_dispersion, dispersion_ratio × |median|))
```

| Choice | Why not the obvious alternative |
| --- | --- |
| **Median, not mean** | The mean is dragged around by the same outliers being hunted: one large transfer inflates it and hides the next nine |
| **MAD, not standard deviation** | Same reason, plus the MAD has a breakdown point near 50% — up to half the window can be garbage before the baseline moves |
| **The scored sample is excluded from its own baseline** | Including it widens the baseline by exactly the anomaly and hides it |
| **Dispersion is floored** | On a flat baseline the MAD is zero, and *every* deviation would score as infinitely anomalous: `0, 0, 0, …` would page on a single failed call. The floor is `max(1.0, 1% of the median)`, so a metric that is usually zero needs a proportionally large jump, and a metric measured in stroops is scored against its own scale |
| **A minimum sample count** | A two-sample baseline is noise with a decimal point; below `min_samples` (12) the metric is reported as unscored instead of guessed at |
| **Median of the last `baseline_window` (96) samples** | Long enough to cover a daily cycle, short enough to notice the contract's behaviour changing |

`z` is reported for every metric — quiet or not — because the number is what
tells an operator whether a threshold is too tight or too loose.

## Rules

Names match `monitoring/alert-rules.yml`; the Prometheus exporter's decoration
(`stellar_` prefix, `_total` suffix) is stripped before matching, so one rule
covers `stellar_contract_invocations_total` and `contract_invocations` alike.

| Metric | Direction | z threshold | Severity | What a firing rule means |
| --- | --- | --- | --- | --- |
| `contract_invocations` | above | 4.0 | warning | Invocation burst — spam, a bot, or a retry storm |
| `contract_failed_invocations` | above | 4.0 | warning | A caller is retrying something that has stopped succeeding |
| `contract_auth_failures` | above | 3.5 | critical | Someone is guessing authorisations |
| `contract_outflow_stroops` | above | 4.0 | critical | Value leaving far above baseline — a drain |
| `bridge_pause_events` | above | 3.0 | critical | The bridge is being taken down repeatedly |
| `nonce_replays` | above | 3.0 | critical | A signed transfer is being re-presented |
| `distinct_senders` | below | 3.5 | warning | Activity has concentrated into very few accounts |
| `contract_entry_ttl_min` | below | 3.5 | warning | The shortest entry TTL is dropping — storage heading for archival |

A metric with **no** rule is reported as `skip …: no rule covers this metric`
rather than scored against a default: a missing rule is a configuration bug, and
silently applying *something* would hide it.

## Running the check

```bash
# Score a committed sample window
cargo run -p stellar-toolkit -- monitoring anomalies --input monitoring/samples/steady.json

# Machine-readable, for a dashboard or a ticket
cargo run -p stellar-toolkit -- monitoring anomalies --input monitoring/samples/outflow-spike.json --json

# Less sensitive (raw threshold multiplier) or a longer baseline
cargo run -p stellar-toolkit -- monitoring anomalies --input window.json --threshold-scale 2.0 --baseline-window 288

# Report without failing the build
cargo run -p stellar-toolkit -- monitoring anomalies --input window.json --fail-on never
```

The command exits non-zero when anything at or above `--fail-on` (default
`critical`) fires, which is what makes it usable as a gate.

### The sample window format

A JSON object mapping metric names to chronological samples, oldest first:

```json
{
  "stellar_contract_invocations_total": [12000, 12048, 12097, 12145],
  "stellar_contract_outflow_stroops": [510000, 498000, 42000000]
}
```

A metric whose name ends in `_total` is a Prometheus counter and is differenced
into per-interval rates before scoring; a counter that goes backwards is read as
an exporter restart and contributes its new value rather than a negative rate.
Everything else is scored as given — including a gauge that happens to rise,
which must not be silently turned into rates.

`monitoring/samples/steady.json` and `monitoring/samples/outflow-spike.json` are
the committed windows the CI job uses: the first must stay quiet, the second must
be caught. They are generated deterministically, so a change to the detector that
alters either outcome is visible in a pull request.

## Two implementations, one catalogue

| | `stellar-toolkit monitoring anomalies` | Prometheus `stellar-anomalies` group |
| --- | --- | --- |
| Statistics | Median + MAD, with the dispersion floor | Median (`quantile_over_time(0.5)`) plus a constant floor |
| Scope | One window, scored once — CI and post-incident replay | Continuous, all contracts, with `for:` durations and Alertmanager routing |
| Authority | **Authoritative** for thresholds and severity | The live-stack approximation, because PromQL has no MAD without a nested subquery |

Change one, change the other: the names, thresholds and severities are meant to
read the same in both files. `crates/stellar-toolkit/src/anomaly.rs` holds the
catalogue, and a unit test asserts it is normalized and uniquely named.

`monitoring/alertmanager.yml` routes criticals to the pager (repeat every hour),
groups warnings by contract (repeat every 4h), and inhibits a contract's warnings
while a critical for the same contract is firing, so a drain does not arrive
buried in its own side effects. It also suppresses every alert for a contract
whose Horizon/Soroban endpoints are down — the cause is in the alert, not in its
consequences.

## Triage runbook

### `AnomalousOutflow` / `contract_outflow_stroops`

1. Treat as a drain in progress. Do not wait for the next evaluation.
2. Check the bridge's pause state: if a pause is requested but not yet effective,
   the timelocked pause (issue #239) is the intended response — a pause cannot
   take effect in the ledger it was requested in, so the window is the delay.
3. Read the largest outflows from Horizon, not from the alert: confirm the
   destination addresses are the ones the bridge is supposed to pay.
4. If the destination is unexpected, `cancel_pending` nothing and escalate to the
   admin key holders; if the outflow is legitimate, raise `dispersion_ratio` or
   the rule threshold and record why.

### `NonceReplaySpotted` / `nonce_replays`

Honest traffic cannot increment this counter — the replay guard only counts
refusals. A value above zero means a signed transfer was re-presented, either by
a retrying relayer or by an attacker. Confirm the original transfer's settlement
state first (see `docs/CROSS_CHAIN_REPLAY.md`), then treat a genuinely replayed
nonce as a hostile relayer.

### `AuthFailureSpike` / `contract_auth_failures`

1. Group the failing invocations by caller; a single address hammering
   `require_auth` is a guessing attempt.
2. If the caller is an integration, check for a rotated key that was not
   deployed; if it is unknown, raise a blocklist/invocation-cost change.

### `AnomalousPauseEvents` / `bridge_pause_events`

Two pauses in an hour is an incident, not maintenance. Reconcile every
`(pause, request)`, `(pause, activate)` and `(pause, cancel)` event against the
change log; a guardian cycling the guard is the pattern to look for
(`docs/BRIDGE_PAUSE_TIMELOCK.md`).

### `SenderConcentration` / `distinct_senders`

Usually legitimate — a market maker, a batch payout — but it is also the shape of
activity being funnelled through one key before an exit. Confirm the concentrated
accounts are known, then decide whether the warning is worth keeping.

### `StorageTtlLow` / `contract_entry_ttl_min`

Entries are bumped on write, so a falling floor means a key has stopped being
written. Find the key, and either bump it explicitly or accept archival
deliberately.

### `AnomalousInvocationBurst` / `AnomalousFailedInvocations`

The cheapest alerts to get wrong. First check whether the contract's traffic
pattern changed on purpose (a new integration, a scheduled job); if it did, the
right fix is usually the baseline — but a permanently raised floor is also how a
sustained drain becomes invisible, so record the decision.

## Tuning

| Knob | Default | Effect |
| --- | --- | --- |
| `--threshold-scale` | `1.0` | Raw multiplier on every rule threshold. 2.0 makes the whole catalogue half as sensitive; 0.5 doubles it |
| `--min-samples` | `12` | Samples required before a baseline is trusted |
| `--baseline-window` | `96` | Samples that form the baseline |
| `min_dispersion` | `1.0` | Absolute floor on the dispersion, for metrics that are usually zero |
| `dispersion_ratio` | `0.01` | Floor as a fraction of the baseline median, for large-magnitude metrics |
| `--fail-on` | `critical` | Lowest severity that makes the command exit non-zero |

All of them are also available to callers of the library through
`anomaly::DetectorConfig` and `anomaly::AnomalyRule`, so a deployment can add its
own metrics without forking the catalogue.

## Tests

`cargo test -p stellar-toolkit --lib anomaly` — 24 tests, covering:

* a flat series staying quiet, and a spike against a flat baseline firing at
  critical;
* the dispersion floor: a zero baseline twitching by one unit is not an incident,
  ten units is;
* the scored sample being excluded from its own baseline, and a median baseline
  absorbing outliers *inside* the window that would inflate a mean;
* `min_samples`, non-finite samples, empty series and unknown metrics being
  reported rather than guessed at or panicked on;
* direction handling (`above`, `below`, `both`) and that a drop does not fire an
  outflow rule;
* metric-name normalization, `_total` counter differencing, counter resets, and
  that a rising *gauge* is not differenced;
* the sweep: per-severity counts, worst severity, `render()` and `to_json()`;
* threshold scaling, rule overrides, and the catalogue being normalized and
  uniquely named;
* loading a window from disk, and the error path for a missing file.

`cargo test -p stellar-toolkit` covers the rest of the crate; the CLI arm is
exercised end-to-end by the two `automated-checks` CI steps described above.
