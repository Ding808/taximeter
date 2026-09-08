# Taximeter specification

Taximeter is an open-source TypeScript meter and ledger for agent payments.
This specification defines the product, architecture, engineering standards, and
release acceptance criteria. The quickstart should provide useful results in
under 30 seconds. Implementation decisions and protocol corrections are recorded
in `DECISIONS.md` and `SPEC-NOTES.md`.

---

## 0. Protocol verification

The x402 descriptions below are a summary. Protocol details must be checked against
the primary sources before implementation:

- `https://github.com/coinbase/x402` — README, `specs/x402-specification-v2.md`,
  `specs/schemes/exact/scheme_exact_evm.md`
- `https://docs.x402.org`
- The actual published npm packages (`@x402/core`, `@x402/evm`, `@x402/fetch`,
  `@x402/express`) — read their `README` and exported types.

Then write `SPEC-NOTES.md` in the repo root recording:

1. The exact v1 and v2 wire formats you found, with real field names.
2. Every place where the brief below disagrees with the real spec.
3. Which version(s) you decided to support and why.

**The real spec wins over this brief, every time.** If they conflict, follow the spec and
note it. Do not invent field names.

---

## 1. What you are building

### The problem, in one paragraph

AI agents now pay for things by themselves — API calls, data, model tokens — thousands of
tiny payments per task, across several payment rails (x402/USDC, Stripe MPP, cards). The
rails answer one question well: *can this payment go through?* They do not answer: *has
this agent blown its budget, which task did this spend belong to, and how do I turn four
rails' records into one invoice?* Today that ledger responsibility falls on whoever runs
the agent — which means nobody does it.

The analogy to keep in your head while designing: **Visa exists, Ramp doesn't.** Card
networks move money; expense-management systems govern it. `taximeter` is the
expense‑management layer for agent payments.

### What `taximeter` is

A local‑first meter and ledger that sits between an agent and the payment rails. It
records every payment, enforces budgets in real time, attributes spend to tasks, and
exports one clean statement.

**Name: `taximeter`.** npm package `taximeter`, CLI binary `taximeter` with the short
alias `txm`. The name was verified unregistered on the npm registry on 2026‑09‑06 — if it
has been taken since, fall back in this order: `tabmeter`, `spendbook`, `agenttab` (all
verified free on the same date), and record the change in `SPEC-NOTES.md`.

**The tagline is the product's whole pitch — use it verbatim in the README, the
`package.json` description, and the GitHub repo description:**

> A taximeter for your AI agents.

Carry the metaphor deliberately, and know its exact limits:

- A taximeter **watches small charges accumulate and shows a running total in a place the
  passenger can see.** That is precisely what this tool does.
- A taximeter **does not take the money** — the driver does. This maps exactly onto the
  non‑custody promise in §1. Lean on this when explaining what the tool is not.
- Do **not** stretch the metaphor into cars, taxis, rides, drivers, or yellow cabs
  anywhere in the naming, UI copy, or visual design. No taxi imagery, no checkered
  patterns, no yellow-cab color scheme. The name earns its keep in one sentence; after
  that the product is a ledger and should look like one (§5).

**Capitalization — apply this table exactly and consistently. There is one rule behind it:
lowercase in every technical context, sentence case in prose.** "Taximeter" is also a
common English noun, so capitalizing it in prose is what marks it as the product rather
than the device in a cab.

| Context | Form | Note |
|---|---|---|
| npm package | `taximeter` | npm rejects uppercase in new package names — not a choice |
| CLI binary + alias | `taximeter`, `txm` | never capitalized; shells are case-sensitive |
| GitHub repo | `taximeter` | match the package name |
| Prose, headings, README H1, docs body | `Taximeter` | proper noun; `# Taximeter` |
| Inline reference to the command | `` `taximeter start` `` | code-styled, lowercase |
| TypeScript types / classes | `TaximeterConfig`, `PaymentEvent` | PascalCase |
| Env vars | `TAXIMETER_DB`, `TAXIMETER_PORT` | SCREAMING_SNAKE_CASE |
| Config file | `taximeter.config.json` | lowercase |
| State directory | `~/.taximeter/` | lowercase |
| HTTP headers | `Taximeter-Task`, `Taximeter-Agent` | Title-Case-With-Hyphens; **no `X-` prefix** — RFC 6648 deprecated it |
| Error codes / enum values | `blocked_by_taximeter` | snake_case, lowercase |
| Wordmark / logo | lowercase `taximeter` | a deliberate lowercase wordmark alongside sentence-case prose is fine and common |

Never write `TaxiMeter`, `TAXIMETER` (outside env vars), or `Taxi Meter`. Do not open a
sentence with the lowercase form — rewrite the sentence instead.

### Explicit non‑goals — do not build these

These are not "later"; building them would make the project worse:

- **No custody.** It never holds funds, never holds private keys, never signs a payment.
- **No facilitator.** It does not verify or settle on‑chain. It observes and gates.
- **No cloud, no account, no telemetry.** Everything runs on localhost. Zero network calls
  except passing traffic through to the upstream the agent was already calling.
- **No Stripe MPP or card rails in v1.** But the internal design must be adapter‑shaped so
  a second rail is a new file, not a refactor. Write the `Rail` interface now; implement
  only the x402 adapter.
- **No auth, no multi‑tenant, no RBAC.** Single developer on one machine.

---

## 2. Architecture

```
   agent process                taximeter                    upstream
  ┌──────────────┐         ┌──────────────────┐        ┌──────────────┐
  │  fetch(...)  │ ──────► │  proxy (rail     │ ─────► │  API server  │
  │              │         │  adapter: x402)  │        │  (402 flow)  │
  └──────────────┘ ◄────── │        │         │ ◄───── └──────────────┘
                           │        ▼         │
                           │   policy engine  │  ← budgets, allow/deny
                           │        │         │
                           │        ▼         │
                           │   ledger (SQLite)│
                           │        │         │
                           │        ▼         │
                           │  dashboard + API │  → localhost UI, CSV/JSON export
                           └──────────────────┘
```

Three entry points, one core:

1. **Proxy mode** (primary) — `taximeter start` runs an HTTP proxy. The agent points at it via
   `HTTP_PROXY` / `HTTPS_PROXY` or an explicit base URL. Zero code change in the agent.
2. **SDK mode** — `import { withMeter } from 'taximeter'` wraps a `fetch` implementation for
   agents that can't use a proxy. Same core, different intake.
3. **Dashboard** — served by the same process on a second port.

### Core modules (each independently unit‑testable, no I/O in pure logic)

| Module | Responsibility |
|---|---|
| `rails/types.ts` | The `Rail` interface: `detect(req,res)`, `parse(...) → PaymentEvent \| null` |
| `rails/x402.ts` | Detect 402 responses and the payment replay; parse v1 and v2 shapes |
| `ledger/` | Append‑only event store; derived running totals; queries |
| `policy/` | Pure functions: given a proposed payment + current totals + config → allow or deny with a reason |
| `proxy/` | HTTP/HTTPS proxy wiring; calls rail → policy → ledger; blocks or forwards |
| `sdk/` | `withMeter(fetch, opts)` |
| `server/` | Dashboard static files + a small read‑only JSON API |
| `export/` | CSV, JSON, and a simple invoice |
| `cli/` | `start`, `report`, `export`, `reset`, `doctor` |

**Rule:** `policy/` and `ledger/` derivations must be pure and synchronous. All I/O lives
at the edges. This is what makes the tests fast and the logic trustworthy.

---

## 3. Data model

Append‑only events. Never update a row; derive everything.

```ts
type PaymentEvent = {
  id: string;                  // uuid v7 (sortable)
  ts: string;                  // ISO 8601, UTC
  rail: 'x402';                // future: 'stripe-mpp' | 'card'
  status: 'observed' | 'blocked';
  reason?: string;             // set when blocked
  amount: string;              // integer string in the asset's smallest unit — NEVER a float
  decimals: number;            // e.g. 6 for USDC
  asset: string;               // contract address or symbol
  assetSymbol?: string;        // 'USDC'
  network: string;             // e.g. 'eip155:8453'
  payTo: string;
  payer?: string;
  resource: string;            // the URL being paid for
  host: string;                // derived, indexed
  txHash?: string;
  taskId?: string;             // from Taximeter-Task header or SDK option
  agentId?: string;            // from Taximeter-Agent header or SDK option
  raw: string;                 // the original parsed payload, JSON string, for auditability
};
```

**Money rule, non‑negotiable:** all amounts are integer strings in the asset's smallest
unit. Never `number`, never floating point, anywhere in the codebase — including the UI and
the CSV. Convert to a display string only at the last render step. Write a lint rule or at
minimum a test that asserts no `parseFloat`/`Number()` touches an amount field.

**Storage:** SQLite via `better-sqlite3`. One table `events`, indices on `(ts)`,
`(taskId)`, `(agentId)`, `(host)`. Default path `~/.taximeter/ledger.db`, overridable.
Migrations in `migrations/` with a `schema_version` table — even for v1.

### Config

`taximeter.config.json` in cwd, or `~/.taximeter/config.json`, or flags. Precedence:
flags > cwd > home > defaults. Ship a documented default that works with zero config.

```jsonc
{
  "budgets": {
    "perTask":  { "amount": "5000000", "asset": "USDC" },   // 5 USDC
    "perAgent": { "amount": "50000000", "asset": "USDC", "window": "24h" },
    "global":   { "amount": "100000000", "asset": "USDC", "window": "24h" }
  },
  "policy": {
    "allowHosts": [],            // empty = allow all
    "denyHosts": [],
    "allowPayTo": [],
    "maxSinglePayment": "1000000" // 1 USDC — anything larger is blocked
  },
  "ports": { "proxy": 8402, "dashboard": 8403 },
  "db": "~/.taximeter/ledger.db"
}
```

---

## 4. Behaviour that must be exactly right

1. **Observe, don't break.** If `taximeter` cannot parse a response, it forwards it
   untouched and records a `parse_failed` diagnostic. **It must never corrupt or drop a
   request it doesn't understand.** This is the single most important behaviour — a tool
   that breaks agents will be uninstalled in one minute.
2. **Block cleanly.** When a policy denies a payment, do not forward the replay. Return a
   `402` to the agent with a JSON body: `{ error: 'blocked_by_taximeter', reason, budget,
   spent, remaining }`. Record a `blocked` event. The agent must be able to understand
   what happened from the response alone.
3. **Budget arithmetic is exact.** Use `BigInt` for all totals. Windowed budgets are
   computed from the event log, not from a running counter that can drift.
4. **Multi‑asset.** Never sum across different assets. If two assets are in play, report
   them separately and say so. Do not invent an exchange rate.
5. **Idempotent.** The same payment observed twice (retry, proxy replay) must not double
   count. Deduplicate on nonce/txHash/resource+ts within a small window; document the rule.
6. **Graceful upstream failure.** If the upstream 5xx's after a payment was signed, record
   the event with a `settlement_unknown` flag. Do not silently drop it.

---

## 5. The dashboard

This is where most tools of this kind look cheap. Do not build a generic admin template.

### Art direction

It is a **ledger**, not an analytics dashboard. It should feel like a well‑set financial
document that happens to be live.

- **Type:** one grotesque for UI text, one monospace for every number. Load from Google
  Fonts with real fallback stacks. All figures use `font-variant-numeric: tabular-nums` so
  columns align.
- **Color:** a single accent. Choose a restrained one and use it only for the accent role —
  the live total, the budget meter fill, active nav. Semantic colors (blocked = warning)
  are separate from the accent and always ship with a text label, never color alone.
  Neutrals should carry a slight hue bias toward the accent, not pure grey.
- **Both themes.** Define the complete light palette as CSS custom properties on bare
  `:root`; redefine only the tokens under `@media (prefers-color-scheme: dark)`. Never
  define a color only inside a media query. `body` sets an explicit background token.
- **No** gradients, glassmorphism, emoji section markers, drop shadows on every card, or
  `rounded-2xl` on everything. Spend border/fill/shadow by role: lift the one thing that
  matters, leave the rest flat.
- **Density over decoration.** A ledger view should show ~30 rows without scrolling on a
  laptop.

### Screens

1. **Now** (default). A hero figure: current spend against the active budget, with a meter.
   Below it: live event stream, newest first, ~30 rows, with a colored left edge only on
   `blocked` rows. This screen is the whole product — someone should understand `taximeter`
   in five seconds of looking at it.
2. **By task / by agent / by host.** A sortable table with a proportional bar in the cell,
   not a separate chart. Tabular numerals, right‑aligned amounts.
3. **Timeline.** One sparkline of spend over the session plus a bar of spend per hour.
   Single hue, direct value labels on the endpoints only, chart text in theme tokens, all
   labels inside the viewBox, `overflow-x: auto` on the container.
4. **Export.** Buttons for CSV / JSON / invoice, with a preview of what will be produced.

### Implementation

React + Vite, prebuilt into `dist/ui/` at publish time and served as static files by the
Node process. `npx` must not trigger a frontend build. Poll a read‑only JSON API every
1000 ms; no WebSocket in v1. The page must render a meaningful empty state that explains
how to point an agent at the proxy — never a blank screen.

---

## 6. The README

The README is the product's landing page. Prioritize a working quickstart and a
short path to the first useful result, with detailed reference material in the docs.

Structure, in this order:

1. **Name + one line.** What it does, no adjectives. Then, immediately:
   ```bash
   npx taximeter start
   ```
2. **A 20‑second demo.** Leave a `docs/demo.gif` placeholder and write
   `docs/RECORDING.md` with the exact `asciinema`/`vhs` commands to produce it, including
   the script of what to type. Reference it from the README.
3. **Why** — three sentences maximum, using the Visa/Ramp framing.
4. **Quickstart** — three steps, each a single copyable command. Then a
   "you should now see this" block showing real expected output.
5. **How it works** — the ASCII architecture diagram from §2, plus four sentences.
6. **Configuration** — a table of every option, its default, and one line of meaning.
7. **What this is not** — the non‑goals from §1 stated plainly. This builds more trust than
   a feature list.
8. **Contributing / license (MIT).**

Rules: no more than three badges. No emoji as section markers. Every code block must be
copy‑pasteable and actually work. Write in plain English — short sentences, active voice,
no marketing adjectives.

---

## 7. Engineering standards

**Stack (pin exact versions in `package.json`, no `^` on tooling):**

- TypeScript 5.x, `strict: true`, `noUncheckedIndexedAccess: true`, no `any` outside
  narrowly-scoped `// eslint-disable` with a reason.
- Node 20+ (`engines` field). ESM only, with a CJS build via `tsup` if trivial.
- `better-sqlite3` for storage; `commander` for CLI; `zod` for all config and wire‑format
  parsing — every external input is parsed, never cast.
- **Biome** for lint + format (one tool, one config). No ESLint + Prettier pair.
- `vitest` for tests; `tsup` for build; `changesets` for versioning.

**Testing — this is not optional:**

- **Unit tests** for `policy/`, `ledger/` derivations, and both x402 wire‑format parsers.
  These are pure functions; aim for ≥90% coverage here.
- **A fixture upstream server** in `test/fixtures/` that speaks real x402: returns a 402
  with payment requirements, accepts the replay, returns 200. Both v1 and v2 shapes.
- **An integration test** that runs the proxy against the fixture, sends 100 payments
  through, and asserts the ledger totals exactly, to the smallest unit.
- **A budget test**: configure a cap that allows exactly 20 payments; assert #21 is blocked,
  that the response body is the documented shape, and that a `blocked` event is recorded.
- **A "don't break things" test**: send traffic the parser does not understand and assert
  the response reaches the client byte‑identical.
- **A determinism test**: the same event log always produces the same totals.
- Snapshot the CSV export. Golden files in `test/__snapshots__/`.

**CI** — GitHub Actions, one workflow: typecheck → lint → test → build, on push and PR,
Node 20 and 22 matrix. A second workflow publishes to npm on a changeset release.

**Repo hygiene:** Conventional Commits. `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`,
`LICENSE` (MIT), `.editorconfig`, `.nvmrc`, issue and PR templates. `CHANGELOG.md`
generated by changesets. A `SECURITY.md` that says plainly: this tool never handles keys or
funds, and here is how to report an issue.

**`.gitignore` — write it deliberately, not from a generic template.** The correctness test
is mechanical: after running `npm ci && npm test && npm run build && npm pack`,
`git status --porcelain` must print **nothing**. Anything a normal workflow generates must
be ignored; anything a contributor needs must not be.

Must be ignored:

```gitignore
# deps & build
node_modules/
dist/
*.tsbuildinfo
.vite/

# test & coverage
coverage/
.nyc_output/
test-results/
tmp/

# npm pack output
*.tgz

# local ledger state — SQLite writes three files, ignore all of them
*.db
*.db-wal
*.db-shm
.taximeter/

# local user config (an example file is committed instead)
taximeter.config.json

# secrets — this project never needs one, but a contributor's test setup might
.env
.env.*
!.env.example

# development logs
*.log

# editors & OS
.DS_Store
Thumbs.db
.idea/
.vscode/*
!.vscode/extensions.json
!.vscode/settings.json
```

Must **not** be ignored — these are deliverables and belong in the repo:
`README.md`, `SPEC.md`, `SPEC-NOTES.md`, `DECISIONS.md`, `VERIFICATION.md`,
`taximeter.config.example.json`, `.changeset/`, `migrations/`,
`test/__snapshots__/`, `.github/`.

Two related rules:

- **Do not create a `.npmignore`.** The `files` whitelist in `package.json` already
  controls the tarball, and having both is a known source of "why is this file missing
  from the published package" bugs.
- **Add a `.gitattributes`** with `* text=auto eol=lf` and `*.sh text eol=lf`. Contributors
  on Windows will otherwise commit CRLF, which breaks the lint step and produces
  whole-file diffs in CI.

**Package:** `files` whitelist so the tarball ships only `dist/`, `dist/ui/`, and docs.
`bin` maps `taximeter` and `txm`. Verify `npm pack` output is under 2 MB and contains no source maps of the
UI.

---

## 8. Build order — commit at every step

Work in this order. After each step, run the full test suite and make a Conventional
Commit. Do not move on with failing tests.

1. Repo scaffold, tooling, CI, a trivial passing test.
2. `SPEC-NOTES.md` from your primary‑source reading.
3. Types + zod schemas for the wire formats and config.
4. `ledger/` with migrations + unit tests.
5. `policy/` pure functions + unit tests (write the tests first here).
6. `rails/x402.ts` parsers + unit tests against real captured payloads.
7. Fixture upstream server.
8. `proxy/` + the integration and "don't break things" tests.
9. `cli/` — `start`, `report`, `export`, `reset`, `doctor`.
10. `export/` + snapshot tests.
11. `sdk/` `withMeter`.
12. Dashboard — data API first, then UI, then the art‑direction pass.
13. README, `docs/RECORDING.md`, contributing docs.
14. `npm pack` and a clean‑machine smoke test (fresh temp dir, `npx ./package.tgz start`).

---

## 9. Acceptance criteria — the build is done when all of these pass

Verify each one and paste the evidence into a `VERIFICATION.md`.

- [ ] On a clean machine with no config file, `npx <pkg> start` boots the proxy and
      dashboard and prints the two URLs plus a one‑line "point your agent here" hint.
- [ ] `npm test` passes; coverage on `policy/` and `ledger/` is ≥ 90%.
- [ ] The integration test pushes 100 payments and the ledger total matches the expected
      value **exactly**, as an integer string.
- [ ] With a budget allowing 20 payments, payment 21 is blocked, the client receives the
      documented JSON body, and a `blocked` event exists in the ledger.
- [ ] Unparseable traffic passes through byte‑identical.
- [ ] `taximeter export --csv out.csv` produces a file whose total equals the dashboard total.
- [ ] The dashboard renders correctly in both light and dark, at 1440px and 390px wide,
      with a real empty state.
- [ ] `npm pack` tarball < 2 MB; `files` whitelist honoured.
- [ ] After `npm ci && npm test && npm run build && npm pack`, `git status --porcelain`
      prints nothing — the `.gitignore` is complete and nothing generated is tracked.
- [ ] README's quickstart, executed literally on a clean machine, works.
- [ ] `SPEC-NOTES.md` documents every place this brief disagreed with the real spec.

---

## 10. Resolving uncertainty

- Resolve protocol ambiguity against the primary source. Support the narrowest
  verified interpretation and document its limits in `SPEC-NOTES.md`.
- Product decisions must preserve the agent's traffic. Record each material
  decision and its rationale in `DECISIONS.md`.
- Document unsupported requirements and specification corrections explicitly.
- Delivery priorities favor correct CLI behavior, ledger arithmetic, and traffic
  preservation before dashboard polish.
