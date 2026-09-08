# Decisions

- 2026-09-08 — Work follows SPEC §8 on `feat/taximeter-v0.1.0`; each numbered step gets a full passing suite and a Conventional Commit.
- Pin better-sqlite3 12.8.0: version 13 requires Node 22, while this release promises Node 20 support.
- ESM only: a second CJS runtime adds packaging complexity without serving the primary CLI or modern fetch integrations.
- Runtime requests are limited to forwarding traffic and the local dashboard API. Development dependency installation and protocol research are build activities.
