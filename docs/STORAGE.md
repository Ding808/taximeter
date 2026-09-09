# Ledger storage: measurements and next reduction

The ledger currently grows monotonically. There is no retention, prune, or
in-place compact command. `reset` archives the existing database. Migration
backups also consume disk until removed. Version 0.2.2 does not change this policy.

## Measure complete payment records

The 500,000-payment benchmark seeds confirmed events without historical
attempt/outcome rows. Its disk sizes are therefore not estimates for a live
ledger with reservation, settlement, and retry history.

A separate Windows / Node 24.13.0 experiment with version 0.2.2 used two datasets
of 1,000 payments each, created through `Meter.begin` and `Meter.complete`.
Each dataset contains 1,000 source payment events, 2,000 outcome rows (reservation
and confirmation), 1,000 cached payments, and 1,000 cached attempts. Fixture
signatures and nonces used deterministic, high-entropy-looking bytes rather
than a repeated signature byte. These are synthetic storage fixtures, not live
payments.

| Tasks / agents | Current database bytes | Identity-repacked control bytes | Repacked without duplicate cache raw bytes |
| --- | --- | --- | --- |
| 1 / 1 | 6,881,280 | 6,836,224 | 5,812,224 |
| 100 / 10 | 7,405,568 | 7,364,608 | 6,340,608 |

Within each dataset, the source `events` payloads and disposable `cache_payments`
payloads each held 729,410 bytes of raw JSON, or 803,410 bytes after escaping
inside the stored JSON. Removing only the cache copy saved 1,024,000 database
bytes relative to each identity-repacked control. The source records were
unchanged. Joining each cached payment to its original event reproduced all 2,000 complete payment
objects and their JSON exports exactly.

Per-row gzip (level 6) and Brotli (quality 4) prototypes wrapped compressed `raw`
as tagged base64 inside both source and cache JSON payloads. The serialized data
shrank, but neither prototype reduced database file bytes relative to its control:
SQLite page occupancy was unchanged. This does not rule out other compression
layouts; it shows why a
smaller JSON string alone is insufficient evidence of disk savings.

The [complete result](../benchmarks/storage-0.2.2.json) includes table/index page
sizes, payload byte counts, codec timings, hydration checks, runtime version,
and hashes of the tested entry and probe. It was captured with
`node scripts/storage-probe.mjs --output benchmarks/storage-0.2.2.json`.

## Reproduce from a checkout

```sh
npm ci
npm run build
node scripts/storage-probe.mjs --output tmp/storage-current.json
```

The [probe](../scripts/storage-probe.mjs) uses fixed, small datasets and makes no
network calls. It creates fresh source databases and experimental copies under
the ignored `tmp/` directory, verifies them, then removes the owned databases.
The requested JSON report remains. `--temp-root` selects another temporary parent;
`--help` describes the options. The experimental copies are storage-layout
prototypes, not formats supported by the released ledger implementation.

This reproduces the method, not necessarily identical file sizes: real write
timestamps affect prefix cardinality, and page occupancy can vary. Compare each
variant with its own identity-repacked control. The experiment does not measure
production traffic, large-history compression, binary-column or block compression,
or the latency of a future runtime that hydrates cached payments from source.
The tagged codec verifies these fixture-generated raw strings exactly; it is
not a general-purpose codec for arbitrary SDK-supplied strings.

## Candidate: store raw once

Keep the original raw authorization in the immutable source event. Omit it only
from the disposable payment projection and load it through the indexed payment
ID when a public reservation object needs it. Outcome processing already reads
the original event, and the pure derivation preserves raw without inspecting it.

This is a measured candidate, not an implemented feature. It requires:

- An explicit incompatible-format gate, such as schema 3. Schema-2 clients require
  `raw` in cached payloads, so silently changing their representation is unsafe.
- Backup before migration, coordinated writer shutdown, rollback tests, and
  unchanged exact reservation/export/rebuild behavior.
- Controlled repacking to reclaim file bytes. Updating smaller values in place
  can leave free pages for reuse without shrinking the file.
- Care around source rowids: SQLite [VACUUM may change implicit rowids](https://www.sqlite.org/lang_vacuum.html).
  Cache cursors depend on them, so a rewrite must preserve them or rebuild the
  projections and cursors before reopening for writes.

## Why date-based deletion needs more design

Default task budgets are all-time. Payment keys retain deduplication identity,
and late settlement outcomes can refer to old payment IDs. Deleting rows before
a date can restore already-spent budget, charge retries twice, lose unresolved
payments, or break exports.

A retention feature needs explicit spend carry-forward, preserved deduplication
and pending-payment references, and exports that include the archived evidence.
The existing archive/reset workflow intentionally starts fresh budget and
deduplication state. It is not retention that preserves accounting continuity,
and keeping the archive does not reduce the total disk space already used.
Use it only when intentionally starting a new ledger, with all writers stopped,
and preserve the archive. Do not prune source tables manually to recover space.
