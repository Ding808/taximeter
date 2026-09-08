# Decisions

- 2026-09-08 — Work follows SPEC §8 on `feat/taximeter-v0.1.0`; each numbered step gets a full passing suite and a Conventional Commit.
- Pin better-sqlite3 12.8.0: version 13 requires Node 22, while this release promises Node 20 support.
- ESM only: a second CJS runtime adds packaging complexity without serving the primary CLI or modern fetch integrations.
- Runtime requests are limited to forwarding traffic and the local dashboard API. Development dependency installation and protocol research are build activities.
- Biome's automatic configuration migration emitted `preset: none`; corrected it to `recommended` immediately so lint remains a real quality gate.
- Initial dependency audit found advisories in uuid 11.1.0 and tsup's esbuild 0.27.x. Pin uuid 11.1.1 and override tsup's esbuild to 0.28.1; validate with the full suite and build. Keep Changesets 2.x for Node 20 compatibility.
- SQLite adds append-only `outcomes` and `diagnostics` tables beside `events`; this preserves original payment authorizations while recording settlement uncertainty and parser diagnostics. The migration is bundled as text from the tracked SQL source.
- Idempotency binds the network/asset/payer/nonce identity to immutable authorization details; conflicting authorizations receive separate conservative reservations rather than bypassing policy through nonce reuse.
- Zod 4 applies inner defaults even through `.partial()`. Configuration patch schemas therefore have no defaults; a regression test verifies later layers cannot reset earlier sibling options.
- Independent ledger tests initially expected checksum-case output and `settlement_unknown: true` on blocked rows. Correct those expectations: EVM identities are canonical lowercase, and a replay blocked before forwarding has no uncertain settlement. Exact-value and deduplication assertions remain intact.
- Track individual forwarding attempts in append-only outcomes. Any unresolved attempt retains capacity; confirmation anywhere wins. An unconfirmed retry outside a rolling window must reacquire capacity, with `attemptedAt` separate from the original immutable timestamp.
- Runtime storage failures fail open and emit a visible local stderr warning: preserving the agent's traffic is the stated highest priority. Budget guarantees require working local storage. The original reservation survives a failed outcome write.
