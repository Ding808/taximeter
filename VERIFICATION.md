# Release verification

The initial release passed the local clean-checkout audit on `feat/taximeter-v0.1.0`.
The historical audit transcripts below cover version 0.1.0. npm ownership was
subsequently established with that version; the next release is 0.1.1.

## Behavioral evidence

At audit commit `336e8e8`, the full suite passed **298 tests in 17 files** on both Node 20 and Node 22.
Both `src/ledger` and `src/policy` had **100% statements, branches, functions,
and lines**. Typecheck and Biome reported zero errors; lint reported zero warnings.

| Requirement | Automated evidence |
| --- | --- |
| 100 payments total exactly | `test/proxy.test.ts`: 100 v1 and 100 v2 replays each yield integer string `700`. |
| Payment 21 blocked at a 20-payment cap | Proxy tests check HTTP 402, all five documented JSON fields, a blocked event, and no upstream replay. A 100-request concurrent race permits exactly 20. |
| Unknown traffic preserved | Proxy/SDK tests compare binary, gzip, large bodies, request bodies, duplicate cookies, trailers, encoded paths, and unrecognized protocol payloads. |
| CLI CSV equals dashboard totals | `test/server.test.ts` writes a real CLI CSV and compares its BigInt sums with a live API response across blocked/failed rows and multiple assets. |
| Deterministic replay | Ledger tests replay events/outcomes and compare exact derived totals. |
| No floating monetary conversion | `test/money-invariant.test.ts` parses every source/UI file and rejects Number/parseFloat/parseInt calls; large-value tests cross the safe-integer boundary. |

## Dashboard evidence

Local Chromium checks exercised all six views in empty and populated states at
1440×1200 and 390×844, with both light and dark browser color schemes. All eight
combinations fit the viewport horizontally, downloaded CSV successfully, and made
no external requests. Screenshots were visually inspected for the live ledger,
mobile empty state, timeline, and export preview. Thirty rows are available;
shorter screens and narrow tables scroll.

The included demo ran successfully against an in-memory ledger and local fixture:

```text
Payment 20 | allowed | total 140 atomic units
Payment 21 | BLOCKED | total 140 atomic units
{"error":"blocked_by_taximeter","reason":"global_budget","budget":"140","spent":"140","remaining":"0"}
Exact ledger total: 140 atomic units. One blocked event recorded.
```

SDK examples were executed against ordinary loopback traffic, including the real
`@x402/fetch` 2.25.0 wrapper with its supported client classes. No signing, actual
payment, wallet, facilitator, or chain access was involved.

## Release audit

Audited source commit: `336e8e85bc61c176ddcea82a17b438d80193978a`. Date: **2026-09-08**.
Two independent Git clones were created outside the working repository on Windows.
Node **20.20.2** and **22.23.2** each used npm **11.6.2** and their own native
SQLite installation. All audit commands below exited zero. Captured standard output
and error streams follow below. Machine-specific paths, line endings, and trailing
whitespace are normalized; command results and diagnostic messages are retained.

The startup harness runs the literal source command from the clean checkout, and
the literal npx command from a fresh directory containing only the tarball. Each
startup uses an empty home, an isolated empty npm cache, no Taximeter configuration
file, and no Taximeter environment overrides. It checks the default listeners,
ledger, API and prebuilt assets, then intentionally stops its own child processes.
This is an installation smoke test, not publication to npm.

The two builds produced the same **158,229-byte**, 25-file tarball at the audited
commit. This evidence document is committed afterward, so later packages include
its transcripts and have a different archive hash/size; the runtime source and
lockfile do not change when the evidence is appended. The package check enforces
the 2,000,000-byte limit on every produced archive.

The README's three source commands took about **13.3 seconds** of combined command
time on Node 20 in this environment (normal development dependency cache). The
separate npx install/start check used a fresh npm cache and completed in **6.7 seconds**.
These measurements are local observations, not a guarantee of download speed.

Dependency installation reports deprecation notices for transitive prebuild-install
and glob; npm's audit reports zero vulnerabilities. Vite reports two removable
annotation comments in Zod. Those notices are retained below. Typecheck has zero
errors, and Biome has zero errors and zero warnings.

### Windows / Node v20.20.2

Clean checkout: `<TEMP>/taximeter-audit-node20/checkout`.

#### git clone (fresh checkout)

```text
Cloning into '<TEMP>/taximeter-audit-node20/checkout'...
done.
```

Exit: 0. Elapsed: 426 ms.

#### node --version

```text
v20.20.2
```

Exit: 0. Elapsed: 70 ms.

#### npm --version

```text
11.6.2
```

Exit: 0. Elapsed: 239 ms.

#### npm ci

```text
npm warn deprecated prebuild-install@7.1.3: No longer maintained. Please contact the author of the relevant native addon; alternatives are available.
npm warn deprecated glob@10.5.0: Old versions of glob are not supported, and contain widely publicized security vulnerabilities, which have been fixed in the current version. Please update. Support for old versions may be purchased (at exorbitant rates) by contacting i@izs.me

added 295 packages, and audited 296 packages in 6s

58 packages are looking for funding
  run `npm fund` for details

found 0 vulnerabilities
```

Exit: 0. Elapsed: 5937 ms.

#### npm run typecheck

```text

> taximeter@0.1.0 typecheck
> tsc --noEmit

```

Exit: 0. Elapsed: 5677 ms.

#### npm run lint

```text

> taximeter@0.1.0 lint
> biome check --error-on-warnings .

Checked 57 files in 56ms. No fixes applied.
```

Exit: 0. Elapsed: 897 ms.

#### npm test

```text

> taximeter@0.1.0 test
> vitest run --coverage


 RUN  v3.2.7 <TEMP>/taximeter-audit-node20/checkout
      Coverage enabled with v8

 ✓ test/config.test.ts (19 tests) 18ms
 ✓ test/fixture.test.ts (2 tests) 83ms
 ✓ test/attempts.test.ts (2 tests) 19ms
 ✓ test/x402.test.ts (74 tests) 98ms
 ✓ test/policy.test.ts (21 tests) 28ms
 ✓ test/core.test.ts (2 tests) 66ms
 ✓ test/scaffold.test.ts (1 test) 2ms
 ✓ test/ledger.test.ts (29 tests) 202ms
 ✓ test/proxy-upgrade.test.ts (3 tests) 66ms
 ✓ test/ui.test.ts (14 tests) 54ms
 ✓ test/hygiene.test.ts (5 tests) 662ms
 ✓ test/money-invariant.test.ts (2 tests) 121ms
 ✓ test/export.test.ts (15 tests) 75ms
 ✓ test/sdk.test.ts (25 tests) 464ms
 ✓ test/cli.test.ts (32 tests) 563ms
 ✓ test/server.test.ts (29 tests) 976ms
 ✓ test/proxy.test.ts (23 tests) 1386ms
   ✓ native HTTP payment proxy > 100 simulated x402 v1 payments produce the exact integer total 700  442ms
   ✓ native HTTP payment proxy > 100 simulated x402 v2 payments produce the exact integer total 700  311ms

 Test Files  17 passed (17)
      Tests  298 passed (298)
   Start at  01:27:53
   Duration  3.14s (transform 2.65s, setup 0ms, collect 13.17s, tests 4.88s, environment 3ms, prepare 4.75s)

 % Coverage report from v8
---------------|---------|----------|---------|---------|-----------------------
File           | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s
---------------|---------|----------|---------|---------|-----------------------
All files      |   95.54 |    91.66 |   97.46 |   95.54 |
 src           |     100 |    97.95 |     100 |     100 |
  assets.ts    |     100 |      100 |     100 |     100 |
  config.ts    |     100 |      100 |     100 |     100 |
  core.ts      |     100 |    96.87 |     100 |     100 | 72
  index.ts     |     100 |      100 |     100 |     100 |
  model.ts     |     100 |      100 |     100 |     100 |
 src/cli       |    80.2 |    72.09 |   66.66 |    80.2 |
  index.ts     |       0 |      100 |     100 |       0 | 2-12
  program.ts   |   84.61 |    71.42 |      60 |   84.61 | 62-86,155-157
 src/config    |   98.36 |    97.05 |     100 |   98.36 |
  io.ts        |   98.36 |    97.05 |     100 |   98.36 | 17
 src/export    |     100 |    96.55 |     100 |     100 |
  index.ts     |     100 |    96.55 |     100 |     100 | 47
 src/ledger    |     100 |      100 |     100 |     100 |
  derive.ts    |     100 |      100 |     100 |     100 |
  store.ts     |     100 |      100 |     100 |     100 |
 src/policy    |     100 |      100 |     100 |     100 |
  index.ts     |     100 |      100 |     100 |     100 |
 src/proxy     |   90.84 |    73.17 |     100 |   90.84 |
  index.ts     |   90.84 |    73.17 |     100 |   90.84 | ...67,279-280,285-286
 src/rails     |     100 |    96.33 |     100 |     100 |
  schemas.ts   |     100 |      100 |     100 |     100 |
  types.ts     |       0 |        0 |       0 |       0 |
  x402.ts      |     100 |    96.26 |     100 |     100 | 43,111,121,225
 src/sdk       |   91.27 |    93.65 |     100 |   91.27 |
  index.ts     |   91.27 |    93.65 |     100 |   91.27 | 97-103,140-145
 src/server    |   96.96 |       91 |     100 |   96.96 |
  index.ts     |     100 |    97.95 |     100 |     100 | 90
  lifecycle.ts |   89.41 |    79.16 |     100 |   89.41 | 31-36,56-58
  schema.ts    |     100 |      100 |     100 |     100 |
  state.ts     |   98.75 |    88.88 |     100 |   98.75 | 39
---------------|---------|----------|---------|---------|-----------------------
```

Exit: 0. Elapsed: 6173 ms.

#### npm run build

```text

> taximeter@0.1.0 build
> tsup && vite build

CLI Building entry: src/index.ts, src/cli/index.ts
CLI Using tsconfig: tsconfig.json
CLI tsup v8.5.1
CLI Using tsup config: <TEMP>/taximeter-audit-node20/checkout\tsup.config.ts
CLI Target: node20
CLI Cleaning output folder
ESM Build start
ESM dist\chunk-I7YXGTRZ.js 44.76 KB
ESM dist\index.js          5.34 KB
ESM dist\cli\index.js      17.91 KB
ESM ⚡️ Build success in 24ms
DTS Build start
DTS ⚡️ Build success in 2485ms
DTS dist\cli\index.d.ts 20.00 B
DTS dist\index.d.ts     14.10 KB
vite v6.4.3 building for production...
transforming...
node_modules/zod/v4/core/util.js (330:0): A comment

"// Wrapped in a `@__PURE__` IIFE: esbuild never tree-shakes a top-level initializer that contains a member access on `Number`, so the bare object literal survived into every bundle."

in "node_modules/zod/v4/core/util.js" contains an annotation that Rollup cannot interpret due to the position of the comment. The comment will be removed to avoid issues.
node_modules/zod/v4/core/regexes.js (70:0): A comment

"/** Anchors a pattern source. The interpolation lives here rather than at the call site because
 * esbuild will not drop a `@__PURE__` call whose own argument interpolates a variable, but it
 * will drop `anchor(dateSource)`. Keeping it inline pinned `date` into every bundle. */"

in "node_modules/zod/v4/core/regexes.js" contains an annotation that Rollup cannot interpret due to the position of the comment. The comment will be removed to avoid issues.
✓ 128 modules transformed.
rendering chunks...
computing gzip size...
../dist/ui/index.html                   0.57 kB │ gzip:  0.35 kB
../dist/ui/assets/index-De4zKRDL.css   15.43 kB │ gzip:  3.89 kB
../dist/ui/assets/index-DOE5bD9P.js   307.37 kB │ gzip: 92.40 kB
✓ built in 1.08s
```

Exit: 0. Elapsed: 6451 ms.

#### npm pack

```text
npm notice
npm notice 📦  taximeter@0.1.0
npm notice Tarball Contents
npm notice 304B CHANGELOG.md
npm notice 1.7kB CODE_OF_CONDUCT.md
npm notice 5.0kB CONTRIBUTING.md
npm notice 11.9kB DECISIONS.md
npm notice 1.1kB LICENSE
npm notice 10.9kB README.md
npm notice 3.7kB SECURITY.md
npm notice 27.5kB SPEC-NOTES.md
npm notice 23.4kB SPEC.md
npm notice 3.8kB VERIFICATION.md
npm notice 45.8kB dist/chunk-I7YXGTRZ.js
npm notice 20B dist/cli/index.d.ts
npm notice 18.3kB dist/cli/index.js
npm notice 14.4kB dist/index.d.ts
npm notice 5.5kB dist/index.js
npm notice 15.4kB dist/ui/assets/index-De4zKRDL.css
npm notice 307.4kB dist/ui/assets/index-DOE5bD9P.js
npm notice 566B dist/ui/index.html
npm notice 42B docs/demo.gif
npm notice 4.9kB docs/demo.mjs
npm notice 202B docs/demo.tape
npm notice 1.7kB docs/RECORDING.md
npm notice 9.5kB docs/SDK.md
npm notice 1.9kB package.json
npm notice 461B taximeter.config.example.json
npm notice Tarball Details
npm notice name: taximeter
npm notice version: 0.1.0
npm notice filename: taximeter-0.1.0.tgz
npm notice package size: 158.2 kB
npm notice unpacked size: 515.4 kB
npm notice shasum: ff654760a19721c626f03932d5bd1f325402d89e
npm notice integrity: sha512-GxdzY44Z6T4gA[...]7ov2pHlY/oykA==
npm notice total files: 25
npm notice
taximeter-0.1.0.tgz
```

Exit: 0. Elapsed: 1171 ms.

#### npm run check:package

```text

> taximeter@0.1.0 check:package
> node scripts/check-package.mjs

Package verified: taximeter-0.1.0.tgz
158229 bytes compressed; 515398 bytes unpacked; 25 files.
Both CLI aliases, ESM entry point, declarations, and prebuilt UI are present.
26 relative Markdown file links resolve inside the package.
Files whitelist honored; no UI source maps, source tree, tests, dependencies, or local state.
```



Exit: 0. Elapsed: 1344 ms.

#### node docs/demo.mjs

```text
Taximeter | local simulation | no money moves
Budget: 140 atomic units. Each payment: 7 atomic units.
Payment  1 | allowed | total 7 atomic units
Payment  2 | allowed | total 14 atomic units
Payment  3 | allowed | total 21 atomic units
Payment  4 | allowed | total 28 atomic units
Payment  5 | allowed | total 35 atomic units
Payment  6 | allowed | total 42 atomic units
Payment  7 | allowed | total 49 atomic units
Payment  8 | allowed | total 56 atomic units
Payment  9 | allowed | total 63 atomic units
Payment 10 | allowed | total 70 atomic units
Payment 11 | allowed | total 77 atomic units
Payment 12 | allowed | total 84 atomic units
Payment 13 | allowed | total 91 atomic units
Payment 14 | allowed | total 98 atomic units
Payment 15 | allowed | total 105 atomic units
Payment 16 | allowed | total 112 atomic units
Payment 17 | allowed | total 119 atomic units
Payment 18 | allowed | total 126 atomic units
Payment 19 | allowed | total 133 atomic units
Payment 20 | allowed | total 140 atomic units
Payment 21 | BLOCKED | total 140 atomic units
{"error":"blocked_by_taximeter","reason":"global_budget","budget":"140","spent":"140","remaining":"0"}
Exact ledger total: 140 atomic units. One blocked event recorded.
```

Exit: 0. Elapsed: 2059 ms.

#### node dist/cli/index.js start (fresh home)

```text

> taximeter@0.1.0 smoke:package
> node scripts/smoke-package.mjs --source

Smoke runtime: v20.20.2
Smoke workspace: <TEMP>/taximeter-package-smoke
PASS: isolated home and npm cache; no Taximeter config file or environment overrides.
$ node dist/cli/index.js start
Taximeter 0.1.0
Proxy: http://127.0.0.1:8402
Dashboard: http://127.0.0.1:8403
Point an HTTP-proxy-aware agent at http://127.0.0.1:8402.
HTTPS CONNECT is unmetered; use --upstream or withMeter for HTTPS payments.
PASS: default proxy 8402 and dashboard 8403; default ledger created in the fresh home.
PASS: validated empty dashboard summary and default budget without configuration.
PASS: prebuilt dashboard HTML and 2 local JS/CSS assets served with correct MIME types.
PASS: smoke HTTP requests stayed on loopback; browser network behavior is verified separately.
PASS: owned CLI and launcher processes stopped.
PASS: verified temporary workspace removed.
```

Exit: 0. Elapsed: 943 ms.

#### npx ./taximeter-0.1.0.tgz start (fresh cwd and home)

```text

> taximeter@0.1.0 smoke:package
> node scripts/smoke-package.mjs

Smoke runtime: v20.20.2
Smoke workspace: <TEMP>/taximeter-package-smoke
PASS: isolated home and npm cache; no Taximeter config file or environment overrides.
$ npx ./taximeter-0.1.0.tgz start
npm warn deprecated prebuild-install@7.1.3: No longer maintained. Please contact the author of the relevant native addon; alternatives are available.
Taximeter 0.1.0
Proxy: http://127.0.0.1:8402
Dashboard: http://127.0.0.1:8403
Point an HTTP-proxy-aware agent at http://127.0.0.1:8402.
HTTPS CONNECT is unmetered; use --upstream or withMeter for HTTPS payments.
PASS: default proxy 8402 and dashboard 8403; default ledger created in the fresh home.
PASS: validated empty dashboard summary and default budget without configuration.
PASS: prebuilt dashboard HTML and 2 local JS/CSS assets served with correct MIME types.
PASS: smoke HTTP requests stayed on loopback; browser network behavior is verified separately.
PASS: owned CLI and launcher processes stopped.
PASS: verified temporary workspace removed.
```

Exit: 0. Elapsed: 6662 ms.

#### git status --porcelain

```text
```

Exit: 0. Elapsed: 119 ms. The empty block is the actual empty output.

### Windows / Node v22.23.2

Clean checkout: `<TEMP>/taximeter-audit-node22/checkout`.

#### git clone (fresh checkout)

```text
Cloning into '<TEMP>/taximeter-audit-node22/checkout'...
done.
```

Exit: 0. Elapsed: 449 ms.

#### node --version

```text
v22.23.2
```

Exit: 0. Elapsed: 82 ms.

#### npm --version

```text
11.6.2
```

Exit: 0. Elapsed: 241 ms.

#### npm ci

```text
npm warn deprecated prebuild-install@7.1.3: No longer maintained. Please contact the author of the relevant native addon; alternatives are available.
npm warn deprecated glob@10.5.0: Old versions of glob are not supported, and contain widely publicized security vulnerabilities, which have been fixed in the current version. Please update. Support for old versions may be purchased (at exorbitant rates) by contacting i@izs.me

added 295 packages, and audited 296 packages in 5s

58 packages are looking for funding
  run `npm fund` for details

found 0 vulnerabilities
```

Exit: 0. Elapsed: 5342 ms.

#### npm run typecheck

```text

> taximeter@0.1.0 typecheck
> tsc --noEmit

```

Exit: 0. Elapsed: 5301 ms.

#### npm run lint

```text

> taximeter@0.1.0 lint
> biome check --error-on-warnings .

Checked 57 files in 45ms. No fixes applied.
```

Exit: 0. Elapsed: 787 ms.

#### npm test

```text

> taximeter@0.1.0 test
> vitest run --coverage


 RUN  v3.2.7 <TEMP>/taximeter-audit-node22/checkout
      Coverage enabled with v8

 ✓ test/config.test.ts (19 tests) 16ms
 ✓ test/attempts.test.ts (2 tests) 16ms
 ✓ test/fixture.test.ts (2 tests) 63ms
 ✓ test/policy.test.ts (21 tests) 24ms
 ✓ test/x402.test.ts (74 tests) 100ms
 ✓ test/core.test.ts (2 tests) 62ms
 ✓ test/money-invariant.test.ts (2 tests) 151ms
 ✓ test/scaffold.test.ts (1 test) 2ms
 ✓ test/ui.test.ts (14 tests) 47ms
 ✓ test/proxy-upgrade.test.ts (3 tests) 71ms
 ✓ test/ledger.test.ts (29 tests) 218ms
 ✓ test/hygiene.test.ts (5 tests) 611ms
 ✓ test/export.test.ts (15 tests) 62ms
 ✓ test/sdk.test.ts (25 tests) 474ms
 ✓ test/cli.test.ts (32 tests) 489ms
 ✓ test/server.test.ts (29 tests) 732ms
 ✓ test/proxy.test.ts (23 tests) 1369ms
   ✓ native HTTP payment proxy > 100 simulated x402 v1 payments produce the exact integer total 700  418ms
   ✓ native HTTP payment proxy > 100 simulated x402 v2 payments produce the exact integer total 700  334ms

 Test Files  17 passed (17)
      Tests  298 passed (298)
   Start at  01:28:02
   Duration  3.29s (transform 1.79s, setup 0ms, collect 16.29s, tests 4.51s, environment 3ms, prepare 5.48s)

 % Coverage report from v8
---------------|---------|----------|---------|---------|-----------------------
File           | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s
---------------|---------|----------|---------|---------|-----------------------
All files      |   95.54 |    91.66 |   97.46 |   95.54 |
 src           |     100 |    97.95 |     100 |     100 |
  assets.ts    |     100 |      100 |     100 |     100 |
  config.ts    |     100 |      100 |     100 |     100 |
  core.ts      |     100 |    96.87 |     100 |     100 | 72
  index.ts     |     100 |      100 |     100 |     100 |
  model.ts     |     100 |      100 |     100 |     100 |
 src/cli       |    80.2 |    72.09 |   66.66 |    80.2 |
  index.ts     |       0 |      100 |     100 |       0 | 2-12
  program.ts   |   84.61 |    71.42 |      60 |   84.61 | 62-86,155-157
 src/config    |   98.36 |    97.05 |     100 |   98.36 |
  io.ts        |   98.36 |    97.05 |     100 |   98.36 | 17
 src/export    |     100 |    96.55 |     100 |     100 |
  index.ts     |     100 |    96.55 |     100 |     100 | 47
 src/ledger    |     100 |      100 |     100 |     100 |
  derive.ts    |     100 |      100 |     100 |     100 |
  store.ts     |     100 |      100 |     100 |     100 |
 src/policy    |     100 |      100 |     100 |     100 |
  index.ts     |     100 |      100 |     100 |     100 |
 src/proxy     |   90.84 |    73.17 |     100 |   90.84 |
  index.ts     |   90.84 |    73.17 |     100 |   90.84 | ...67,279-280,285-286
 src/rails     |     100 |    96.33 |     100 |     100 |
  schemas.ts   |     100 |      100 |     100 |     100 |
  types.ts     |       0 |        0 |       0 |       0 |
  x402.ts      |     100 |    96.26 |     100 |     100 | 43,111,121,225
 src/sdk       |   91.27 |    93.65 |     100 |   91.27 |
  index.ts     |   91.27 |    93.65 |     100 |   91.27 | 97-103,140-145
 src/server    |   96.96 |       91 |     100 |   96.96 |
  index.ts     |     100 |    97.95 |     100 |     100 | 90
  lifecycle.ts |   89.41 |    79.16 |     100 |   89.41 | 31-36,56-58
  schema.ts    |     100 |      100 |     100 |     100 |
  state.ts     |   98.75 |    88.88 |     100 |   98.75 | 39
---------------|---------|----------|---------|---------|-----------------------
```

Exit: 0. Elapsed: 6277 ms.

#### npm run build

```text

> taximeter@0.1.0 build
> tsup && vite build

CLI Building entry: src/index.ts, src/cli/index.ts
CLI Using tsconfig: tsconfig.json
CLI tsup v8.5.1
CLI Using tsup config: <TEMP>/taximeter-audit-node22/checkout\tsup.config.ts
CLI Target: node20
CLI Cleaning output folder
ESM Build start
ESM dist\chunk-I7YXGTRZ.js 44.76 KB
ESM dist\index.js          5.34 KB
ESM dist\cli\index.js      17.91 KB
ESM ⚡️ Build success in 20ms
DTS Build start
DTS ⚡️ Build success in 2017ms
DTS dist\cli\index.d.ts 20.00 B
DTS dist\index.d.ts     14.10 KB
vite v6.4.3 building for production...
transforming...
node_modules/zod/v4/core/util.js (330:0): A comment

"// Wrapped in a `@__PURE__` IIFE: esbuild never tree-shakes a top-level initializer that contains a member access on `Number`, so the bare object literal survived into every bundle."

in "node_modules/zod/v4/core/util.js" contains an annotation that Rollup cannot interpret due to the position of the comment. The comment will be removed to avoid issues.
node_modules/zod/v4/core/regexes.js (70:0): A comment

"/** Anchors a pattern source. The interpolation lives here rather than at the call site because
 * esbuild will not drop a `@__PURE__` call whose own argument interpolates a variable, but it
 * will drop `anchor(dateSource)`. Keeping it inline pinned `date` into every bundle. */"

in "node_modules/zod/v4/core/regexes.js" contains an annotation that Rollup cannot interpret due to the position of the comment. The comment will be removed to avoid issues.
✓ 128 modules transformed.
rendering chunks...
computing gzip size...
../dist/ui/index.html                   0.57 kB │ gzip:  0.35 kB
../dist/ui/assets/index-De4zKRDL.css   15.43 kB │ gzip:  3.89 kB
../dist/ui/assets/index-DOE5bD9P.js   307.37 kB │ gzip: 92.40 kB
✓ built in 866ms
```

Exit: 0. Elapsed: 5365 ms.

#### npm pack

```text
npm notice
npm notice 📦  taximeter@0.1.0
npm notice Tarball Contents
npm notice 304B CHANGELOG.md
npm notice 1.7kB CODE_OF_CONDUCT.md
npm notice 5.0kB CONTRIBUTING.md
npm notice 11.9kB DECISIONS.md
npm notice 1.1kB LICENSE
npm notice 10.9kB README.md
npm notice 3.7kB SECURITY.md
npm notice 27.5kB SPEC-NOTES.md
npm notice 23.4kB SPEC.md
npm notice 3.8kB VERIFICATION.md
npm notice 45.8kB dist/chunk-I7YXGTRZ.js
npm notice 20B dist/cli/index.d.ts
npm notice 18.3kB dist/cli/index.js
npm notice 14.4kB dist/index.d.ts
npm notice 5.5kB dist/index.js
npm notice 15.4kB dist/ui/assets/index-De4zKRDL.css
npm notice 307.4kB dist/ui/assets/index-DOE5bD9P.js
npm notice 566B dist/ui/index.html
npm notice 42B docs/demo.gif
npm notice 4.9kB docs/demo.mjs
npm notice 202B docs/demo.tape
npm notice 1.7kB docs/RECORDING.md
npm notice 9.5kB docs/SDK.md
npm notice 1.9kB package.json
npm notice 461B taximeter.config.example.json
npm notice Tarball Details
npm notice name: taximeter
npm notice version: 0.1.0
npm notice filename: taximeter-0.1.0.tgz
npm notice package size: 158.2 kB
npm notice unpacked size: 515.4 kB
npm notice shasum: ff654760a19721c626f03932d5bd1f325402d89e
npm notice integrity: sha512-GxdzY44Z6T4gA[...]7ov2pHlY/oykA==
npm notice total files: 25
npm notice
taximeter-0.1.0.tgz
```

Exit: 0. Elapsed: 682 ms.

#### npm run check:package

```text

> taximeter@0.1.0 check:package
> node scripts/check-package.mjs

Package verified: taximeter-0.1.0.tgz
158229 bytes compressed; 515398 bytes unpacked; 25 files.
Both CLI aliases, ESM entry point, declarations, and prebuilt UI are present.
26 relative Markdown file links resolve inside the package.
Files whitelist honored; no UI source maps, source tree, tests, dependencies, or local state.
```

Exit: 0. Elapsed: 930 ms.

#### node docs/demo.mjs

```text
Taximeter | local simulation | no money moves
Budget: 140 atomic units. Each payment: 7 atomic units.
Payment  1 | allowed | total 7 atomic units
Payment  2 | allowed | total 14 atomic units
Payment  3 | allowed | total 21 atomic units
Payment  4 | allowed | total 28 atomic units
Payment  5 | allowed | total 35 atomic units
Payment  6 | allowed | total 42 atomic units
Payment  7 | allowed | total 49 atomic units
Payment  8 | allowed | total 56 atomic units
Payment  9 | allowed | total 63 atomic units
Payment 10 | allowed | total 70 atomic units
Payment 11 | allowed | total 77 atomic units
Payment 12 | allowed | total 84 atomic units
Payment 13 | allowed | total 91 atomic units
Payment 14 | allowed | total 98 atomic units
Payment 15 | allowed | total 105 atomic units
Payment 16 | allowed | total 112 atomic units
Payment 17 | allowed | total 119 atomic units
Payment 18 | allowed | total 126 atomic units
Payment 19 | allowed | total 133 atomic units
Payment 20 | allowed | total 140 atomic units
Payment 21 | BLOCKED | total 140 atomic units
{"error":"blocked_by_taximeter","reason":"global_budget","budget":"140","spent":"140","remaining":"0"}
Exact ledger total: 140 atomic units. One blocked event recorded.
```

Exit: 0. Elapsed: 2003 ms.

#### node dist/cli/index.js start (fresh home)

```text

> taximeter@0.1.0 smoke:package
> node scripts/smoke-package.mjs --source

Smoke runtime: v22.23.2
Smoke workspace: <TEMP>/taximeter-package-smoke
PASS: isolated home and npm cache; no Taximeter config file or environment overrides.
$ node dist/cli/index.js start
Taximeter 0.1.0
Proxy: http://127.0.0.1:8402
Dashboard: http://127.0.0.1:8403
Point an HTTP-proxy-aware agent at http://127.0.0.1:8402.
HTTPS CONNECT is unmetered; use --upstream or withMeter for HTTPS payments.
PASS: default proxy 8402 and dashboard 8403; default ledger created in the fresh home.
PASS: validated empty dashboard summary and default budget without configuration.
PASS: prebuilt dashboard HTML and 2 local JS/CSS assets served with correct MIME types.
PASS: smoke HTTP requests stayed on loopback; browser network behavior is verified separately.
PASS: owned CLI and launcher processes stopped.
PASS: verified temporary workspace removed.
```

Exit: 0. Elapsed: 866 ms.

#### npx ./taximeter-0.1.0.tgz start (fresh cwd and home)

```text

> taximeter@0.1.0 smoke:package
> node scripts/smoke-package.mjs

Smoke runtime: v22.23.2
Smoke workspace: <TEMP>/taximeter-package-smoke
PASS: isolated home and npm cache; no Taximeter config file or environment overrides.
$ npx ./taximeter-0.1.0.tgz start
npm warn deprecated prebuild-install@7.1.3: No longer maintained. Please contact the author of the relevant native addon; alternatives are available.
Taximeter 0.1.0
Proxy: http://127.0.0.1:8402
Dashboard: http://127.0.0.1:8403
Point an HTTP-proxy-aware agent at http://127.0.0.1:8402.
HTTPS CONNECT is unmetered; use --upstream or withMeter for HTTPS payments.
PASS: default proxy 8402 and dashboard 8403; default ledger created in the fresh home.
PASS: validated empty dashboard summary and default budget without configuration.
PASS: prebuilt dashboard HTML and 2 local JS/CSS assets served with correct MIME types.
PASS: smoke HTTP requests stayed on loopback; browser network behavior is verified separately.
PASS: owned CLI and launcher processes stopped.
PASS: verified temporary workspace removed.
```

Exit: 0. Elapsed: 5891 ms.

#### git status --porcelain

```text
```

Exit: 0. Elapsed: 105 ms. The empty block is the actual empty output.

## Captured browser QA output

The local Chromium check used the final UI CSS/JS produced by the build. It checked
48 view/state/theme/width combinations, eight CSV downloads, and zero page errors.
Screen height varied as described above; horizontal table/chart scrolling is contained.

```text
PASS empty-light-1440: 1440px page width, no external requests
PASS empty-light-1440: all six views fit; CSV download works
PASS empty-light-390: 390px page width, no external requests
PASS empty-light-390: all six views fit; CSV download works
PASS empty-dark-1440: 1440px page width, no external requests
PASS empty-dark-1440: all six views fit; CSV download works
PASS empty-dark-390: 390px page width, no external requests
PASS empty-dark-390: all six views fit; CSV download works
PASS populated-light-1440: 1440px page width, no external requests
PASS populated-light-1440: all six views fit; CSV download works
PASS populated-light-390: 390px page width, no external requests
PASS populated-light-390: all six views fit; CSV download works
PASS populated-dark-1440: 1440px page width, no external requests
PASS populated-dark-1440: all six views fit; CSV download works
PASS populated-dark-390: 390px page width, no external requests
PASS populated-dark-390: all six views fit; CSV download works
Screenshots: <CHECKOUT>/tmp/dashboard-qa
```

## Limits

- Fixtures are synthetic protocol envelopes. Genuine wallet/facilitator/on-chain
  interoperability has not been tested.
- Windows browser checks use Chromium. Other browser engines, a live Linux
  desktop, and Linux browser rendering have not been exercised here.
- Native Windows ConPTY capture and agg encoding were executed for the follow-up
  demo recording documented below. VHS and asciinema command-line recipes have not been run.
- Historical registry-authentication failures below preceded npm ownership setup.
  The 0.1.1 checks and release status are recorded separately from those transcripts.
- Long-running/high-volume ledger performance, disk exhaustion, and OS crash
  recovery have not been stress-tested. Storage failures preserve traffic and
  can prevent enforcement; hidden redirects, unsupported forms, and encrypted
  streams are also outside complete budget visibility.

All implementation deviations and pending repository-description/public-release
actions are listed at the top of [SPEC-NOTES.md](SPEC-NOTES.md).

## Windows demo recording

On **2026-09-08**, `docs/demo.gif` was recorded from the local simulation, replacing
the initial placeholder shown in the historical package audit outputs above.
Product source and dependencies did not change.

The source recording is an asciicast v2 capture. node-pty 1.1.0 runs `cmd.exe`
through Windows ConPTY to type
`node docs/demo.mjs`, and capture its actual terminal output at 104 columns by 32
rows. The recorder asserts the block and exact total and requires shell exit 0.
agg 1.9.0 renders the capture; the existing FFmpeg 9.0.1 creates the MP4.

The official agg Windows executable's SHA-256 matched:

```text
810BAF5506E74CA65D8ED85BE3DB58791086C8B7B0A17C9018D7FEDE473F0055
```

Actual capture output:

```text
Recorded 52 terminal events over 20 seconds to <RECORDING>/demo.cast
Demo assertions passed; command shell exited with status 0.
```

The renderer scans Windows fonts and warned about the unrelated `mstmc.ttf`
font face. The selected Consolas font rendered correctly; beginning, intermediate,
and final frames were visually inspected. The full block JSON and exact total fit
together without horizontal wrapping. The final reading pause is explicitly set
because agg omits trailing no-op output events. No demo output was replaced.

Actual `ffprobe` GIF output:

```json
{
    "programs": [],
    "stream_groups": [],
    "streams": [
        {
            "width": 1049,
            "height": 653,
            "nb_frames": "42"
        }
    ],
    "format": {
        "duration": "20.000000",
        "size": "96519"
    }
}
```

Actual `ffprobe` MP4 output:

```json
{
    "programs": [],
    "stream_groups": [],
    "streams": [
        {
            "width": 1050,
            "height": 654,
            "nb_frames": "400"
        }
    ],
    "format": {
        "duration": "20.000000",
        "size": "188853"
    }
}
```

The GIF copied into `docs/demo.gif` has SHA-256
`6D98F96ED4C91CA27EA4A786E3B4A142905EDA321112AC97EEEF2075E9C89161`.
The captured run permits 20 payments, blocks payment 21, returns the documented
five-field JSON body, and reports exactly `140` atomic units with one blocked
event. Signatures, responses, and settlement reports remain synthetic.

Follow-up checks passed before appending this evidence. Actual output excerpts:

```text
> taximeter@0.1.0 lint
> biome check --error-on-warnings .

Checked 57 files in 39ms. No fixes applied.

> taximeter@0.1.0 check:package
> node scripts/check-package.mjs

Package verified: taximeter-0.1.0.tgz
245338 bytes compressed; 644969 bytes unpacked; 25 files.
Both CLI aliases, ESM entry point, declarations, and prebuilt UI are present.
26 relative Markdown file links resolve inside the package.
Files whitelist honored; no UI source maps, source tree, tests, dependencies, or local state.

 Test Files  17 passed (17)
      Tests  298 passed (298)
   Start at  01:53:34
   Duration  2.28s (transform 893ms, setup 0ms, collect 6.12s, tests 4.54s, environment 4ms, prepare 2.68s)
```

Ledger and policy coverage remained 100% in all four metrics. The final package
is regenerated after this documentation update and still subject to the enforced
2,000,000-byte compressed size limit.

## Release authentication checks

The hosted Release job completed the package build, then failed to publish because
no npm token or OIDC authentication was available. The relevant log output was:

```text
No NPM_TOKEN or OIDC available - assuming npm is already authenticated
ENEEDAUTH This command requires you to be logged in to https://registry.npmjs.org
```

The publish hook now checks for the configured `NPM_TOKEN` and runs an npm identity
check before building. This hook runs only in Changesets' publishing path, so
version PR creation still works without npm credentials. Identity validation
does not certify package write permission or 2FA bypass.

Bash syntax validation and an isolated npm stub exercised all branches without
registry access or publication. Captured output:

```text
PASS missing-token: exit 1; npm calls 0
PASS rejected-token: exit 1; npm calls 1
PASS accepted-token: exit 0; npm calls 2
PASS release-failure: exit 42; npm calls 2
PASS all publishing preflight checks; npm was stubbed and nothing was published.
```

The repository owner must supply a publishing-capable Actions secret before the
hosted release can succeed. No live publication is represented by these checks.

## Version 0.1.1 release checks

The package version is now the source for the CLI, SDK, dashboard API, and archive
validation. This prevents runtime version strings from lagging behind a Changesets
release. Version 0.1.1 was generated through `npm run version-packages` with the
matching package-lock metadata and changelog.

On Windows with Node 24.13.0, typecheck, lint, all 298 tests, the build, package
validation, isolated archive installation/startup, and CLI version checks passed.
Ledger and policy coverage remained 100% in all four metrics. The isolated smoke
check verified both listeners, the empty dashboard summary, prebuilt assets, and
an installation directory with no configuration file.

Captured final package-check output before adding this transcript:

```text
> taximeter@0.1.1 lint
> biome check --error-on-warnings .

Checked 58 files in 45ms. No fixes applied.

> taximeter@0.1.1 check:package
> node scripts/check-package.mjs

Package verified: taximeter-0.1.1.tgz
246248 bytes compressed; 648100 bytes unpacked; 25 files.
Both CLI aliases, ESM entry point, declarations, and prebuilt UI are present.
26 relative Markdown file links resolve inside the package.
Files whitelist honored; no UI source maps, source tree, tests, dependencies, or local state.
```

`node dist/cli/index.js --version` returned `0.1.1`. Subsequent archive sizes include
this transcript; the same package validation enforces the size limit.

## Version 0.1.2 package contents

Development specifications, decisions, verification transcripts, contribution
files, and demo recording sources remain tracked in the repository and are
excluded from the npm archive. The package check permits only the runtime,
consumer documentation, demo image, license, security policy, changelog, and
example configuration. Packaged guides link to repository-only documents on GitHub.

On Windows with Node 24.13.0, typecheck and lint passed, all 298 tests passed, and
ledger and policy coverage remained 100%. The build and isolated installation
and startup check passed with no configuration file. Captured package output:

```text
Package verified: taximeter-0.1.2.tgz
209006 bytes compressed; 532666 bytes unpacked; 16 files.
Both CLI aliases, ESM entry point, declarations, and prebuilt UI are present.
6 relative Markdown file links resolve inside the package.
Files whitelist honored; no UI source maps, source tree, tests, dependencies, or local state.
```

## Version 0.2.0: asset policy and ledger scaling

The default policy now rejects parsed payments for unknown network/contract pairs.
Proxy and SDK regressions verify that rejection occurs before forwarding and
records the exact `unknown_asset` body. Explicit opt-in, matching custom-token
budgets, spoofed metadata, and malformed traffic have separate coverage.

Cached budget snapshots are compared with full replay across all five window
choices and all three scopes, including inclusive boundaries, future timestamps,
clock reversal, null attribution, 79-digit aggregate totals, duplicates, late
settlement evidence, retry timestamp moves, rebuilds, migration, independent
connections, older open writers, and rollback. A 3,000-payment regression makes
all full-history read methods throw during paid intake and still requires real
reservations, settlement confirmation, and exact cap enforcement.

### Measured payment path

Measured sequentially on this Windows x64 machine with Node 24.13.0. The baseline
was the actual published 0.1.2 archive. Both versions used the same
`scripts/benchmark-ledger.mjs`, synthetic x402 v2 USDC envelopes, three active
24-hour budgets, and history spread over 22 hours. Each size used one fresh
file database and 100 timed `Meter.begin` + `Meter.complete` operations after
closing/reopening the seeded database. Timing excludes request construction and
final checks, includes the first payment, and uses nearest-rank p95. This is a
local synthetic measurement, not a network throughput or production latency claim.

| Historical payments | 0.1.2 median / p95 (ms) | 0.2.0 median / p95 (ms) |
| --- | --- | --- |
| 1,000 | 8.424 / 10.091 | 2.325 / 3.837 |
| 10,000 | 92.743 / 101.168 | 2.412 / 3.867 |
| 50,000 | 539.939 / 572.485 | 3.272 / 4.189 |

Every run verified all measured payments were metered and confirmed, exact totals,
the next payment's budget rejection, and zero diagnostics. Returning an unmetered
empty intake fails the benchmark. At 50,000 historical payments, closed database
size increased from 116,019,200 bytes to 285,630,464 bytes: the persistent cache
trades disk space and extra writes for bounded budget lookup. Seeding that sample
took 3,096.065 ms in 0.1.2 and 42,002.451 ms in 0.2.0; these figures include
fixture parsing and insertion, not just cache construction. Normal reopen took
1.748 ms and 1.928 ms respectively. The compact prefix table uses SQLite
[`WITHOUT ROWID`](https://www.sqlite.org/withoutrowid.html) to avoid storing its
composite lookup key twice. Original source tables retain their rowids.

Reproduce after building each entry, using absolute paths for a baseline entry:

```sh
node scripts/benchmark-ledger.mjs --counts 1000,10000,50000 --payments 100 --batches 1
node scripts/benchmark-ledger.mjs --entry /absolute/path/to/0.1.2/dist/index.js --counts 1000,10000,50000 --payments 100 --batches 1
```

The hot path synchronizes only newly appended source rows and reads fixed-depth
prefix keys. Source catch-up and initial migration remain proportional to newly
discovered records. Full reports, exports, and dashboard reads still replay the
source log; their cost is not included in the payment-path measurements.

Final local checks on Node 24.13.0 passed: typecheck, lint, 341 tests across 20
files, build, package contents, and isolated startup. Ledger coverage is 100%
statements/functions/lines and 95.76% branches; policy coverage is 100% in all
four metrics. Captured final package output:

```text
Package verified: taximeter-0.2.0.tgz
213655 bytes compressed; 551748 bytes unpacked; 16 files.
Both CLI aliases, ESM entry point, declarations, and prebuilt UI are present.
6 relative Markdown file links resolve inside the package.
Files whitelist honored; no UI source maps, source tree, tests, dependencies, or local state.
```

## Version 0.2.1: migration recovery and larger ledgers

Ten migration regressions verify that the stderr notice precedes backup and
backfill, a standalone schema-1 backup includes committed WAL events/outcomes/
diagnostics, fresh and schema-2 opens stay quiet, and failed backfills preserve
both the source schema and a valid backup. Repeated failures create distinct
backups. Backup failures abort before schema changes; failures inside the copy
leave only a partial file and close the reader. An independent writer is rejected
while the backup is taken. A migrating CLI JSON report remains parseable.

The source keeps an immediate transaction while a separate read-only connection
runs `VACUUM INTO` with `synchronous=FULL`. This includes committed WAL pages
without allocating a database-sized JavaScript buffer. SQLite documents the
[consistent backup and output sync behavior](https://www.sqlite.org/lang_vacuum.html)
and [immediate writer exclusion](https://www.sqlite.org/lang_transaction.html).
Rollback uses a new database path; it does not rely on implicit rowid identity
or claim atomicity between filesystem renaming and the source database commit.

An additional Windows process-level probe used the actual published 0.1.2 entry
to reopen the completed backup and compare events, derived outcomes, and exact
totals. The source main file was 4,096 bytes while 193,672 bytes remained in its
WAL. Another probe started the built 0.2.1 CLI with 10,000 legacy payments and
ephemeral listeners: `Migrating ledger…` arrived at 199.63 ms; listeners were
ready at 1,775.12 ms. Both the migrated source and the backup opened by 0.1.2
contained 10,000 events totaling exactly `"10000"` atomic units. These elapsed
times are observations from one local run, not startup guarantees.

Final local checks used Node 24.13.0. Typecheck and lint passed, as did all 351
tests across 21 files. Ledger coverage is 100% statements/functions/lines and
95.87% branches; policy coverage is 100% in every metric. Build and isolated
package startup passed. Captured verification output:

```text
Test Files  21 passed (21)
     Tests  351 passed (351)

Package verified: taximeter-0.2.1.tgz
214632 bytes compressed; 554394 bytes unpacked; 16 files.
Both CLI aliases, ESM entry point, declarations, and prebuilt UI are present.
7 relative Markdown file links resolve inside the package.
Files whitelist honored; no UI source maps, source tree, tests, dependencies, or local state.

Taximeter 0.2.1
Proxy: http://127.0.0.1:8402
Dashboard: http://127.0.0.1:8403
PASS: default proxy 8402 and dashboard 8403; default ledger created in the fresh home.
PASS: validated empty dashboard summary and default budget without configuration.
PASS: prebuilt dashboard HTML and 2 local JS/CSS assets served with correct MIME types.
PASS: owned CLI and launcher processes stopped.
PASS: verified temporary workspace removed.
```

### Throughput interpretation

The earlier 3.272 ms median covers sequential `Meter.begin` plus `Meter.complete`.
Its reciprocal is roughly 306 operations/second, but that is an estimate from a
median, not measured lock-hold time, sustained throughput, or a concurrency
ceiling. The two calls include JavaScript work and multiple transactions; a true
throughput measurement must include the full distribution, competing writers,
and the intended traffic workload.

The committed `scripts/benchmark-ledger.mjs` now accepts task and agent partition
counts and reports populated `cache_prefix` partitions and rows. Final source
verification streams one payment and its outcomes at a time, checks exact totals,
all settlements and attribution, the next payment's exact rejection body, zero
diagnostics, and every cache partition root. Cache statistics are collected
**after** timing to avoid a full index scan warming the measured reads.

### 500,000-payment experiment

Measured sequentially on the same Windows x64 / Node 24.13.0 machine, using the
built 0.2.1 entry, default SQLite settings, one fresh database per case, and 100
timed payments per size. History covers 22 hours and all three 24-hour budgets
are active. There are no untimed warm-up payments or pre-timing cache scans;
seeding naturally touches the database and the OS file cache is not cleared.
Median and nearest-rank p95 include the first payment. Some independent checks
ran during seeding; heavy local work was paused during each measured phase.

Historical fixtures are already-confirmed payment events appended in one outer
transaction; they have no historical attempt/outcome rows. Each timed payment
does create its reservation and confirmed outcome. This matches the prior
benchmark but means database sizes are for this fixture, not a storage forecast
for live traffic with retries and settlement history. Task and agent labels cycle
independently: 1,000 tasks and 100 agents create 1,101 cache partitions including
global, rather than 100,000 task-agent combinations.

With one task and one agent (three cache partitions including the global scope):

| Historical payments | Median / p95 (ms) | First payment (ms) | Cache prefix rows | Closed database bytes |
| --- | --- | --- | --- | --- |
| 50,000 | 3.378 / 4.382 | 13.889 | 512,310 | 286,093,312 |
| 500,000 | 3.327 / 4.209 | 9.172 | 3,990,435 | 2,739,785,728 |

Seeding took 44.634 and 515.583 seconds respectively; reopening took 2.911 and
2.063 ms. Final streamed source verification took 0.573 and 5.651 seconds and
confirmed exact totals of `"350700"` and `"3500700"`, including the 100 measured
payments. Cache row counts and database sizes are measured after those payments
and the next payment's rejection. Source verification and cache statistics are
outside the payment timings.

With 1,000 tasks and 100 agents (1,101 populated cache partitions):

| Historical payments | Median / p95 (ms) | First payment (ms) | Cache prefix rows | Closed database bytes |
| --- | --- | --- | --- | --- |
| 50,000 | 3.763 / 4.881 | 14.194 | 748,372 | 318,271,488 |
| 500,000 | 3.994 / 7.624 | 7.624 | 6,055,344 | 2,996,031,488 |

Seeding took 52.719 and 678.611 seconds; reopening took 2.959 and 2.679 ms.
Streamed source verification took 0.585 and 8.358 seconds. Both cases passed
the same exact-amount, settlement, attribution, rejection, and cache checks.

At ten times the history, the single-group median stayed near 3.3 ms. The
many-group median increased about 6%, while its p95 increased from 4.881 to
7.624 ms (about 56%). This supports bounded payment lookup in these samples,
but does not establish constant tail latency: prefix growth and larger working
sets still have costs. Each row is only one 100-payment batch; repeated batches
and concurrent writers are the next useful measurements. Full reports, exports,
and dashboard replay remain outside this benchmark.

The complete machine-readable results are committed with the harness:
[single-group results](benchmarks/ledger-0.2.1-single.jsonl) and
[many-group results](benchmarks/ledger-0.2.1-many.jsonl). They include runtimes,
timing boundaries, sizes, seed/verification times, and populated partitions.
Reproduce using the same flags (`--temp-root` may be changed to an absolute local
directory):

```sh
npm run build
node scripts/benchmark-ledger.mjs --counts 50000,500000 --payments 100 --batches 1 --progress-every 5000 --task-partitions 1 --agent-partitions 1
node scripts/benchmark-ledger.mjs --counts 50000,500000 --payments 100 --batches 1 --progress-every 5000 --task-partitions 1000 --agent-partitions 100
```

No new full-scale 0.1.2 measurements were run for this patch; its compatibility
with the extended harness was checked on a small fixture. The 0.1.2 comparison
in the preceding release section remains the earlier measured baseline.

## 0.2.2: live testnet payment and first CONNECT notice

Verified on Windows x64 / Node 24.13.0, 2026-09-09 UTC (2026-09-08 local time).
The runtime change emits the existing encrypted CONNECT diagnostic sentence to
stderr once across proxy instances. Every valid tunnel still records its own
diagnostic. Four regressions cover concurrent instances, invalid CONNECT, binary
payload transparency, synchronous and asynchronous stderr failures, and an
unavailable upstream. The asynchronous EPIPE regression reproduced the unhandled
stream error before switching the notice to Node Console's error-tolerant writer.

### Real payment and recorded demo

The [private development example](examples/live-testnet/README.md) pins
`@x402/core`, `@x402/evm`, `@x402/express`, and `@x402/fetch` to 2.25.0, viem to
2.56.3, and Express to 5.2.1. It starts the actual built CLI with an explicit
local HTTP upstream and a fresh disk ledger. The official Express server calls
`https://x402.org/facilitator`; the client signs outside Taximeter. The independent
receipt checks use `https://sepolia.base.org` and enforce chain ID 84532.

The final recorded run transferred exactly `"1000"` atomic test USDC units:

- [Transaction](https://sepolia.basescan.org/tx/0x10dc76728133356363ad1dd8d694a5e1eee2086fc3325ca572d3d035e7062c58): `0x10dc76728133356363ad1dd8d694a5e1eee2086fc3325ca572d3d035e7062c58`.
- Canonical block `46574350`, hash `0x5fc419afd6dc2b27ceab4d51c6f17d5862f46ba6e0da1cb04f5d7c77ae90b700`; observed chain height `46574351`.
- The block contains the transaction. One matching canonical USDC Transfer log has the same block/transaction identity and is not removed.
- Payer balance changed from `"19999000"` to `"19998000"`; recipient from `"1000"` to `"2000"`.
- Two initial 402 challenges and two signed replays reached the proxy. Only one signed request reached Express, and verify/settle/handler counts each remained one after blocking the second replay.
- The block response was exactly `{"error":"blocked_by_taximeter","reason":"global_budget","budget":"1000","spent":"1000","remaining":"0"}`. No second balance change or settlement header occurred.
- Ledger and dashboard agreed on `"1000"` confirmed units, zero unknown units, one observed payment, one blocked event, and zero diagnostics. CLI and SDK error counts were zero; both local servers closed successfully.

The [redacted evidence](docs/evidence/base-sepolia-0.2.2.json) and
[unaltered terminal capture](docs/evidence/live-0.2.2.cast) are committed.
The run took 7,757 ms through verification, excluding final cleanup and recording
holds. The 20-second GIF is 1168×693, 27 frames, and 76,492 bytes; its final frame
was visually inspected. The recording retains actual output and original pauses,
then extends the final hold. H.264 MP4 output is also retained locally.

The first live run found a case synthetic fixtures had missed: the receipt wait
resolved with an all-zero block hash. Its real transfer was subsequently proven
by a separate [read-only canonical lookup](docs/evidence/base-sepolia-0.2.2-initial-proof.json).
The harness now polls reads until it can check nonzero canonical block identity,
transaction membership, log metadata, and independently observed confirmation
depth. The final recording also encountered the initial zero hash and required
two receipt observations before accepting proof. Eight offline proof tests cover
that path, inconsistent block hashes/numbers, insufficient height, reverts,
timeouts, wrong transactions, and removed or mismatched logs.

These runs establish one real Base Sepolia v2 exact EIP-3009 flow and its budget
block. They do not establish Ethereum finality, mainnet behavior, live SDK mode,
HTTPS-upstream payment coverage, or an independent human cold-start study.
Taximeter still trusts matching upstream settlement headers; only the separate
development harness queries the chain. Keys and raw authorization ledgers remain
local and are excluded from both Git and the published package.

### Package and test checks

The full suite passed with 355 tests in 22 files. Ledger coverage is 100%
statements/functions/lines and 95.87% branches; policy coverage is 100% throughout.
The independent example's eight proof tests also pass. Selected real command
output follows; the dependency warnings remain visible rather than being counted
as a clean audit:

```text
$ npm ci
added 295 packages, and audited 296 packages in 4s
3 moderate severity vulnerabilities

$ npm run typecheck
> taximeter@0.2.2 typecheck
> tsc --noEmit

$ npm run lint
> biome check --error-on-warnings .
Checked 76 files in 43ms. No fixes applied.

$ npm test
Test Files  22 passed (22)
     Tests  355 passed (355)

$ npm --prefix examples/live-testnet test
tests 8
pass 8
fail 0

$ npm run build
ESM dist\index.js          5.32 KB
ESM dist\cli\index.js      17.92 KB
ESM dist\chunk-DJPLFDD7.js 61.19 KB
DTS dist\cli\index.d.ts 20.00 B
DTS dist\index.d.ts     14.76 KB
✓ 130 modules transformed.
✓ built in 728ms

$ npm pack
taximeter-0.2.2.tgz

$ npm run check:package
Package verified: taximeter-0.2.2.tgz
205672 bytes compressed; 536122 bytes unpacked; 16 files.
Both CLI aliases, ESM entry point, declarations, and prebuilt UI are present.
7 relative Markdown file links resolve inside the package.
Files whitelist honored; no UI source maps, source tree, tests, dependencies, or local state.

$ npm run smoke:package
$ npx ./taximeter-0.2.2.tgz start
Taximeter 0.2.2
Proxy: http://127.0.0.1:8402
Dashboard: http://127.0.0.1:8403
PASS: default proxy 8402 and dashboard 8403; default ledger created in the fresh home.
PASS: validated empty dashboard summary and default budget without configuration.
PASS: prebuilt dashboard HTML and 2 local JS/CSS assets served with correct MIME types.
PASS: owned CLI and launcher processes stopped.
PASS: verified temporary workspace removed.

$ npm audit --omit=dev
found 0 vulnerabilities
```

Installation also reports the existing `prebuild-install` and development `glob`
deprecations. The build succeeds with the existing two Zod PURE-comment warnings.
The three moderate audit entries represent one development-only Vitest advisory,
[GHSA-82fw-gwwq-j7x9](https://github.com/vitest-dev/vitest/security/advisories/GHSA-82fw-gwwq-j7x9),
propagated through Vitest, its mocker, and coverage package. This repository runs
Node tests without exposing the affected mocker plugins or a browser-mode server.
A coordinated Vitest/coverage major upgrade is a follow-up; production audit is
separately clean as shown above.

### Storage remains a known limit

There is still no retention, pruning, or compact command. The committed
[storage probe](scripts/storage-probe.mjs) and [results](benchmarks/storage-0.2.2.json)
measure 2,000 synthetic payments with 4,000 outcome rows and verify exact hydration
and export parity. Removing only duplicate cache raw data saved 1,024,000 bytes
per 1,000-payment dataset relative to its repacked control. Tagged per-row
gzip/Brotli did not save database bytes in these samples. The
[storage note](docs/STORAGE.md) records scope, reproduction commands, and why an
incompatible format migration and accounting-preserving archive design are needed.

After committing the verified candidate, `git status --porcelain` printed nothing.
Dependencies, builds, coverage, packed archives, and local example state stayed
ignored. The evidence and reproduction sources were the intentional additions.

## 0.3.0 — visible configuration and payment-count budgets (2026-09-09)

The automated suite passes **493 tests in 28 files**. The separate live-example
proof-helper suite passes **8 tests**; these are offline proof-validation tests,
not a new on-chain transfer. Typecheck and lint pass. Ledger coverage is **100%**
statements/functions/lines and **96.56%** branches, above the previous 95.87%
branch result. Policy coverage remains **100%** in all four metrics.

Coverage of the new behavior is explicit:

- `config-visibility.test.ts` and `config-cli.test.ts`: layer contributions and
  overridden keys, empty allow-list meanings, doctor JSON/loader agreement,
  common CLI options, and every new startup override.
- `config-edit.test.ts`: human/atomic amounts, unknown symbols, typo suggestions,
  byte-identical files after invalid edits, merged-config errors with full paths,
  target-layer asset context, same-directory atomic replacement, mode `0o600`,
  and original-file preservation with temporary-file cleanup on rename failure.
- `payment-count-policy.test.ts`, `ledger-cache.test.ts`, and `hot-path.test.ts`:
  amount-before-count order in each scope, count-only schemas, zero-value payments,
  blocked/failed exclusion, retries, windows, asset/network matching, exact replay
  parity, and payment gating without loading the historical event arrays.
- `ledger-migration.test.ts`: schema-1/2 backups precede migration, include WAL
  records, and survive failed upgrades; a caught-up v2 cursor still rebuilds
  matching v3 counts. Old schema guards accept the backup and reject v3.
- `count-only-integration.test.ts`: the resolved configuration reaches the Meter
  and actual HTTP proxy without silently restoring default amount limits/windows.
- `blocked-notice.test.ts` and `config-cli.test.ts`: once-per-reason notices across
  meter instances, console-failure isolation, a real CLI proxy blocking its sixth
  payment under a temporary five-payment cap, unchanged configuration files,
  verbatim numeric fix execution, and enforcement changing only after restart.
- `server.test.ts` and `ui.test.ts`: amount/count and count-only summaries, empty
  states, and rejection of dashboard configuration mutation routes. A browser
  visual check also confirmed a count-only dashboard showing 4/5 payments and
  all-time usage with no configuration controls.

The packed **taximeter-0.3.0.tgz** passed the content checker: **216,779 compressed
bytes**, **576,216 unpacked bytes**, **16 files**, and all seven relative Markdown
file links resolving within the archive. Development documents, test sources,
local database/config files, and UI source maps remain excluded.

The extended package smoke test starts the installed tarball under an isolated
home and npm cache. It verifies default loopback listeners and prebuilt assets,
then runs the installed `doctor --json`, `config set`, and `config get` commands.
`200USDC` is stored as `"200000000"`, doctor JSON agrees, and the already-running
dashboard retains its original limit until restart. Owned processes and the
temporary workspace are cleaned up. The existing prebuild-install deprecation
and two Zod PURE-comment build warnings remain non-fatal.

### Reproduce the many-group performance comparison

Build first, then run the committed harness with the same settings as the 0.2.1
many-group baseline:

```sh
npm ci
npm run build
node scripts/benchmark-ledger.mjs --counts 50000,500000 --payments 100 --batches 1 --progress-every 5000 --task-partitions 1000 --agent-partitions 100
```

JSON goes to stdout and progress to stderr. Results are committed in
[ledger-0.3.0-many.jsonl](benchmarks/ledger-0.3.0-many.jsonl), with the built entry's
SHA-256, runtime, parameters, database sizes, and correctness checks. The harness
now also verifies exact payment-count roots in every populated partition when
the count column exists; older baseline entries remain supported. Final source
replay verifies amounts independently of the cache.

Both runs used Node v24.13.0 on Windows x64, 1,000 task partitions, 100 agent
partitions, and one batch of 100 measured payments per history size. The 0.2.1
baseline is [ledger-0.2.1-many.jsonl](benchmarks/ledger-0.2.1-many.jsonl).

| Historical payments | 0.2.1 median | 0.3.0 median | Change | 0.2.1 p95 | 0.3.0 p95 | Change |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 50,000 | 3.763 ms | 4.023 ms | +6.9% | 4.881 ms | 5.942 ms | +21.7% |
| 500,000 | 3.994 ms | 3.640 ms | -8.9% | 7.624 ms | 5.227 ms | -31.4% |

At 500,000 historical payments, reopening took 2.158 ms and the database after
the measured batch was **3,020,705,792 bytes** (about 3.02 GB), compared with
2,996,031,488 bytes in the baseline. The cache contained 6,054,078 prefix rows
across 1,101 partitions. Exact amount replay and all populated partition count
roots matched at both history sizes; each result reports `countsVerified: true`.

The larger history did not increase the median or p95 in this run. This is one
small timing sample at each size, with no warmup, on a shared Windows machine:
it does not establish a speedup, statistical significance, or constant tail
latency. The 50k p95 regression remains visible above. Compare this many-group
run with the many-group baseline, not the earlier single-group 3.3 ms figure.
Timing covers the local `Meter.begin`/`Meter.complete` path, including serialized
write transactions; it is not an end-to-end network throughput measurement.

As in the baseline, historical fixtures omit attempt/outcome rows. The measured
payments include their real reservation/settlement outcomes, but the historical
database sizes remain optimistic compared with equivalent live traffic. This
release adds no retention or compaction, and retained storage continues to grow.
