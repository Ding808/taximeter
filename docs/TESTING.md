# Testing and benchmarks

## Run the checks

Use Node 20 or 22 with npm. CI runs both versions on Windows and Linux:

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run build
npm pack
npm run check:package
npm run smoke:package
```

The suite covers exact accounting, reservations and retries, budgets, transparent
forwarding, exports, configuration edits, migration backups, and dashboard access.
Policy and ledger coverage must remain at least 90%. Integration fixtures use
localhost services and synthetic authorizations, with no wallet or testnet funds.

The package checker validates entry points, file inclusion, relative documentation
links, and the 2 MB archive limit. The package smoke test installs into an isolated
home/cache, starts the default loopback services, checks the dashboard assets and
configuration commands, then stops its processes and removes its temporary files.
Ports 8402 and 8403 must be free. Stop any existing CLI before running this check.

## Ledger performance

Build first, then run the committed harness from the repository root:

```sh
node scripts/benchmark-ledger.mjs --counts 50000,500000 --payments 100 --batches 1 --progress-every 5000 --task-partitions 1000 --agent-partitions 100
```

JSON results go to stdout and progress goes to stderr. The harness seeds a fresh
ledger, reopens it, and times `Meter.begin` plus `Meter.complete`. Outside the
timed section it independently replays source amounts, checks count-cache roots,
and verifies exact budget rejection. Run one case at a time without competing
load; `--help` describes the baseline and temporary-directory options.

The recorded runs use Node 24.13.0 on Windows x64, one batch of 100 measured
payments, 1,000 task partitions, and 100 agent partitions:

| History | 0.2.1 median / p95 | 0.3.0 median / p95 |
| --- | --- | --- |
| 50,000 payments | 3.763 / 4.881 ms | 4.023 / 5.942 ms |
| 500,000 payments | 3.994 / 7.624 ms | 3.640 / 5.227 ms |

Raw records: [0.2.1 multi-group](../benchmarks/ledger-0.2.1-many.jsonl),
[0.3.0 multi-group](../benchmarks/ledger-0.3.0-many.jsonl), and
[0.2.1 single-group](../benchmarks/ledger-0.2.1-single.jsonl).

These small samples do not establish a speedup or constant tail latency. The
50k p95 increased 21.7% in the newer run. Local transaction timings are not
end-to-end network throughput. Different grouping patterns also change cache
cardinality, so single-group and multi-group results should not be conflated.

The 0.3.0 database at 500k historical payments was 3,020,705,792 bytes. Historical
fixtures omit attempt/outcome rows, so real traffic consumes more storage.
[Storage measurements](STORAGE.md) include complete payment lifecycles and a
separate reproducible probe. No retention or compaction command is implemented.

## Live testnet evidence

The [separate example](../examples/live-testnet/README.md) uses the official x402
client and Express middleware with Base Sepolia test USDC. The client signs and
the facilitator settles; Taximeter only observes and gates the HTTP replay.

The recorded 0.2.2 run paid 0.001 test USDC, verified its canonical receipt,
Transfer log and balance changes, then blocked a second payment at the exact
budget. Public evidence is in [the receipt record](evidence/base-sepolia-0.2.2.json)
and [terminal capture](evidence/live-0.2.2.cast). The initial proof attempt is also
retained in [its own record](evidence/base-sepolia-0.2.2-initial-proof.json).

This is one local-HTTP-seller testnet flow, not proof of mainnet or SDK/HTTPS
coverage. Reproduction and rendering commands are in [RECORDING.md](RECORDING.md).
Offline checks for the example's evidence validators can be run separately:

```sh
npm --prefix examples/live-testnet test
```
