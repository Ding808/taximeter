# Release verification

The release passed the clean-checkout audit on `feat/taximeter-v0.1.0`. Public npm publication,
repository visibility changes, and hosted CI execution are not claimed.

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
SQLite installation. All commands below exited zero. No results were fabricated
or substituted; the captured standard output and error streams follow below.
Only line endings and trailing whitespace are normalized for the repository.

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

Clean checkout: `C:\Users\PigeonD\AppData\Local\Temp\taximeter-audit-node20-04Yagr\checkout`.

#### git clone (fresh checkout)

```text
Cloning into 'C:\Users\PigeonD\AppData\Local\Temp\taximeter-audit-node20-04Yagr\checkout'...
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


 RUN  v3.2.7 C:/Users/PigeonD/AppData/Local/Temp/taximeter-audit-node20-04Yagr/checkout
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
CLI Using tsup config: C:\Users\PigeonD\AppData\Local\Temp\taximeter-audit-node20-04Yagr\checkout\tsup.config.ts
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
Smoke workspace: C:\Users\PigeonD\AppData\Local\Temp\taximeter-package-smoke-1qzKd4
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
Smoke workspace: C:\Users\PigeonD\AppData\Local\Temp\taximeter-package-smoke-diOLvj
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

Clean checkout: `C:\Users\PigeonD\AppData\Local\Temp\taximeter-audit-node22-syqCfV\checkout`.

#### git clone (fresh checkout)

```text
Cloning into 'C:\Users\PigeonD\AppData\Local\Temp\taximeter-audit-node22-syqCfV\checkout'...
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


 RUN  v3.2.7 C:/Users/PigeonD/AppData/Local/Temp/taximeter-audit-node22-syqCfV/checkout
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
CLI Using tsup config: C:\Users\PigeonD\AppData\Local\Temp\taximeter-audit-node22-syqCfV\checkout\tsup.config.ts
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
Smoke workspace: C:\Users\PigeonD\AppData\Local\Temp\taximeter-package-smoke-MdtFzf
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
Smoke workspace: C:\Users\PigeonD\AppData\Local\Temp\taximeter-package-smoke-xCvlSY
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
Screenshots: E:\Taximeter\tmp\dashboard-qa-1788844193213
```

## Limits

- Fixtures are synthetic protocol envelopes. Genuine wallet/facilitator/on-chain
  interoperability has not been tested.
- Windows browser checks use Chromium. Other browser engines, a live Linux
  desktop, and hosted GitHub Actions runs have not been exercised here.
- Native Windows ConPTY capture and agg encoding were executed for the follow-up
  demo recording documented below. VHS and asciinema command-line recipes have not been run.
- The npm name remains unpublished. The README's source commands work before
  publication; its registry command requires the first public release.
- Long-running/high-volume ledger performance, disk exhaustion, and OS crash
  recovery have not been stress-tested. Storage failures preserve traffic and
  can prevent enforcement; hidden redirects, unsupported forms, and encrypted
  streams are also outside complete budget visibility.

All implementation deviations and pending repository-description/public-release
actions are listed at the top of [SPEC-NOTES.md](SPEC-NOTES.md).

## Follow-up: actual Windows demo recording

On **2026-09-08**, the user requested downloading the recording tools to E: and
recording the demo on this computer. `docs/demo.gif` now contains the actual local
simulation, replacing the initial placeholder shown in the historical package
audit outputs above. Product source and dependencies did not change.

The Windows workspace is `E:\Taximeter-Demo`. It contains the original asciicast
v2 capture, raw terminal output, GIF, MP4, recording helpers, and downloaded tools.
The helpers use node-pty 1.1.0 to run `cmd.exe` through Windows ConPTY, type
`node docs/demo.mjs`, and capture its actual terminal output at 104 columns by 32
rows. The recorder asserts the block and exact total and requires shell exit 0.
agg 1.9.0 renders the capture; the existing FFmpeg 9.0.1 creates the MP4.

The official agg Windows executable's SHA-256 matched:

```text
810BAF5506E74CA65D8ED85BE3DB58791086C8B7B0A17C9018D7FEDE473F0055
```

Actual capture output:

```text
Recorded 52 terminal events over 20 seconds to /E:/Taximeter-Demo/demo.cast
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
