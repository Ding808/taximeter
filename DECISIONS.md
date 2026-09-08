# Decisions

- 2026-09-08 — Work follows SPEC §8 on `feat/taximeter-v0.1.0`; each numbered step gets a full passing suite and a Conventional Commit.
- Pin better-sqlite3 12.8.0: version 13 requires Node 22, while this release promises Node 20 support.
- ESM only: a second CJS runtime adds packaging complexity without serving the primary CLI or modern fetch integrations.
- Runtime requests are limited to forwarding traffic and the local dashboard API. Development dependency installation and protocol research are build activities.
- Biome's automatic configuration migration emitted `preset: none`; corrected it to `recommended` immediately so lint remains a real quality gate.
- Initial dependency audit found advisories in uuid 11.1.0 and tsup's esbuild 0.27.x. Pin uuid 11.1.1 and override tsup's esbuild to 0.28.1; validate with the full suite and build. Keep Changesets 2.x for Node 20 compatibility.
