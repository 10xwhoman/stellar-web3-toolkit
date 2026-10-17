# Monitoring Dashboard — Testnet Contracts

**Issue:** #121 Build monitoring dashboard for testnet contracts.

## Overview

The monitoring dashboard polls Horizon and Soroban RPC, verifies deployed WASM hashes against the reproducible build, and exposes Prometheus metrics + Grafana + a static HTML dashboard.

## Components

- **CLI:** `crates/stellar-toolkit/src/monitoring_dashboard.rs` — `cargo run -p stellar-toolkit -- monitoring dashboard|check|restore`
- **Static UI:** `monitoring/dashboard/index.html` — browser fetch to `horizon-testnet.stellar.org` + `soroban-testnet.stellar.org`, auto-refresh 30s
- **Prometheus:** `monitoring/prometheus.yml` — scrapes `localhost:9091/metrics` (output of `monitoring dashboard`)
- **Alerts:** `monitoring/alert-rules.yml` — `ContractNotFound`, `AnomalousTxVolume`, `HorizonDown`, `WasmHashMismatch`, `HighFailedTxRate`, plus the `stellar-anomalies` group (issue #124) that scores each metric against its own median instead of a fixed line
- **Alert routing:** `monitoring/alertmanager.yml` — criticals page immediately, a contract's warnings are inhibited while a critical for the same contract is firing
- **Grafana:** `monitoring/grafana-dashboard.json` — import into Grafana at `http://localhost:3000`

## Quickstart

```bash
# Build contracts first (so WASM exists for hash check)
./scripts/reproducible-build.sh

# Generate snapshot
cargo run -p stellar-toolkit -- monitoring dashboard --output target/monitoring --print-metrics
open target/monitoring/report.html
cat target/monitoring/metrics.txt

# Verify the snapshot against its checksums.sha256 manifest (issue #248)
cargo run -p stellar-toolkit -- monitoring restore --snapshot target/monitoring

# CI check (fails on WASM hash mismatch)
cargo run -p stellar-toolkit -- monitoring check --checksums target/reproducible/wasm-checksums.txt

# Anomaly sweep over a sample window (exits non-zero on a critical; issue #124)
cargo run -p stellar-toolkit -- monitoring anomalies --input monitoring/samples/steady.json

# Live stack
docker compose up prometheus alertmanager grafana
# Prometheus http://localhost:9090  Alertmanager http://localhost:9093  Grafana http://localhost:3000 (admin/admin)
```

The rules above are fixed thresholds. The baseline-relative rules, the sample
window format, the tuning knobs and the per-alert triage runbook are in
[`docs/ANOMALY_ALERTING.md`](./ANOMALY_ALERTING.md).

## Metrics

| Metric | Type | Labels |
|--------|------|--------|
| `stellar_contract_up` | gauge | `contract_id` (1 = healthy) |
| `stellar_contract_wasm_hash_mismatch` | gauge | `contract_id` (1 = mismatch) |
| `stellar_horizon_up` | gauge | — |
| `stellar_soroban_up` | gauge | — |

`WasmHashMismatch` bridges reproducible builds (#119) and releases (#120): if deployed bytecode ≠ locally built WASM, the alert fires.

## Tests

```bash
cargo test -p stellar-toolkit monitoring_dashboard -- --nocapture
```
