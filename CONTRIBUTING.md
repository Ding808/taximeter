# Contributing to Taximeter

Taximeter observes agent payments, records them locally, and gates supported
authorizations against budgets. Start with [SPEC-NOTES.md](SPEC-NOTES.md) for the supported protocol and
[DECISIONS.md](DECISIONS.md) for implementation choices.

## Development

Use Node.js 20 or 22 and npm. The package is TypeScript with ESM exports. CI is
configured for both Node versions on Linux and Windows. Dependencies and tooling
are pinned; keep `package-lock.json` consistent with `package.json`.

From a checkout, run the same sequence as CI:

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run build
npm pack
npm run check:package
npm run smoke:package
git status --porcelain
```

The build creates the Node package in `dist/` and the prebuilt React dashboard in
`dist/ui/`. A package consumer must not need to build the dashboard. On a clean
checkout, the final command must print nothing. During development, it should
show only your intentional changes. Do not commit generated bundles, coverage,
tarballs, local configuration, or SQLite state.

Use `npm run format` to apply Biome formatting. Keep LF line endings as specified
in `.gitattributes`. Check the package contents and compressed size with
`npm pack --dry-run`; the release tarball must stay below 2 MB.

The [live testnet example](examples/live-testnet/README.md) is a separate private
development package with pinned payment-client dependencies. Run it manually
with disposable Base Sepolia test tokens; it is excluded from the published
package and default test suite. Its client handles signing outside Taximeter.
The [storage probe](docs/STORAGE.md) runs offline and records the cost of complete
payment lifecycles without changing the product's storage format.

## Changes that preserve trust

- Preserve unknown HTTP traffic byte for byte. Record a diagnostic when a format
  cannot be parsed; do not guess the payment fields or rewrite its payload.
- Store monetary amounts as integer strings. Use `BigInt` for arithmetic and
  convert to a display string only at the rendering edge. Never combine assets
  or networks, infer exchange rates, or use floating point for money.
- Parse external inputs with Zod. Keep strict TypeScript types and
  `noUncheckedIndexedAccess`; do not introduce `any` to silence a type error.
- Keep policy and ledger derivations pure and synchronous. Evaluate policy and
  reserve capacity within the same SQLite transaction before forwarding.
- Keep events and outcomes append-only. Preserve uncertainty, retry identity,
  concurrent attempt accounting, and original attribution.
- Never add custody, private-key handling, payment signing, settlement,
  telemetry, hosted accounts, or runtime metadata lookups. Runtime networking
  is limited to forwarding the caller's traffic and the local dashboard.

Read the primary x402 specification and published package types before changing
a wire parser. Record changed assumptions and supported subsets in
`SPEC-NOTES.md`. An internal model field is not necessarily a protocol field.

## Tests and review

For policy changes, write the failing behavioral test first. Add regressions for
traffic corruption, arithmetic, replay, concurrency, and settlement failures when
changing those paths. Keep policy and ledger coverage at least 90%; coverage is
a floor, not a substitute for asserting observable behavior.

Fixtures use synthetic authorizations and localhost servers. Tests must not
require wallets, keys, funds, a facilitator, or an external API. Keep cleanup
bounded to directories created by the test. Dashboard changes should be checked
in light and dark themes at both desktop and narrow mobile widths.

The offline ledger benchmark is committed at `scripts/benchmark-ledger.mjs`.
After `npm run build`, compare history size with fixed attribution, then repeat
with more task and agent groups:

```sh
node scripts/benchmark-ledger.mjs --counts 50000,500000 --payments 100 --batches 1
node scripts/benchmark-ledger.mjs --counts 50000,500000 --payments 100 --batches 1 --task-partitions 1000 --agent-partitions 100
```

Run cases sequentially on the same machine without other heavy work during
timing. `--help` lists the baseline-entry and temporary-directory options.
Each case reports JSON to stdout and progress to stderr; it verifies exact
source totals, settlement, attribution, budget rejection, and cache partition
roots after timing. Source verification streams one payment at a time so a
500,000-payment run does not allocate a full replay array. Measurements and
their limits are recorded in [VERIFICATION.md](VERIFICATION.md).

Golden CSV snapshots live in `test/__snapshots__/`. Regenerate a snapshot only
for an intentional output change that is explained in the pull request and
accepted in review. Never update a snapshot, remove a test, or relax an assertion
simply to make a failure disappear.

Open a focused pull request with the problem, resulting behavior, and actual
validation results. Explain compatibility changes and known limitations. Use
Conventional Commits, such as `fix(proxy): preserve response trailers`. Update
the relevant docs when behavior or configuration changes. Report vulnerabilities
privately as described in [SECURITY.md](SECURITY.md).

## Versioning and releases

For a user-visible change, run `npm run changeset` and commit the generated
changeset with the change. Describe its effect on users and choose the appropriate
version bump. Documentation-only changes may omit a changeset when they do not
change package behavior.

The release workflow uses Changesets on `main` to prepare version changes and
publish after the release pull request is merged. With no pending changesets,
the action also publishes the current version if npm does not yet contain it.
A push to `main` with working npm credentials can therefore publish directly.
Maintainers configure npm credentials separately.
`npm run version-packages` updates package versions and
the changelog; `npm run release` builds and runs Changesets publishing. Publishing
requires maintainer authorization and credentials. The presence of that workflow
does not mean any package version has already been published.

### npm publishing credentials

The current workflow uses token authentication. Create an npm **granular access
token** with package **Read and write** permissions and **Bypass two-factor
authentication** enabled for unattended publishing. Give it permission to publish
the intended package and an appropriate expiration. Follow the
[npm token setup instructions](https://docs.npmjs.com/creating-and-viewing-access-tokens/).

For the first publication of a new unscoped package, it cannot yet be selected
individually in npm's token settings. A temporary bootstrap token needs the
**All Packages** selection to permit creating it. Replace it with a token limited
to `taximeter` after the package exists, or use trusted publishing for later releases.

In the repository's **Settings → Secrets and variables → Actions**, add a
**repository secret** named exactly `NPM_TOKEN`. Use the token as its value.
An Actions variable or a Dependabot secret will not populate `secrets.NPM_TOKEN`.
An environment secret needs a matching job environment; this workflow does not
select one. Organization secrets must grant this repository access. See
[GitHub's Actions secret instructions](https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions).

`changesets/action@v1` configures npm authentication from this secret. Its publish
hook checks that the secret is present and that npm accepts the credentials
before building or publishing. This identity check does not prove package write
permission or 2FA bypass; npm validates those during publication. Version PRs
can still be prepared without npm credentials. Do not commit a token to `.npmrc`
or paste one into an issue or chat.

After adding or correcting the secret, rerun the failed Release job. A local
`npm login` does not authenticate a GitHub-hosted runner. `ENEEDAUTH` combined
with `No NPM_TOKEN or OIDC available` means the runner received no usable
authentication; the successful build and dependency-comment warnings do not
resolve that missing configuration.

Trusted publishing is a separate setup, not enabled by adding `GITHUB_TOKEN`.
It requires npm-side trust, a supported npm CLI, and `id-token: write` on the
workflow. The present hook deliberately requires `NPM_TOKEN`; migrate both the
hook and workflow together when adopting
[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).
The package must already exist before trust can be configured; see the
[npm trust prerequisites](https://docs.npmjs.com/cli/v11/commands/npm-trust/).

Contributions are provided under the project's [MIT license](LICENSE). Follow the
[code of conduct](CODE_OF_CONDUCT.md) in issues, reviews, and other project spaces.
