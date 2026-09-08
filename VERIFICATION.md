# Release verification

The release is being verified on `feat/taximeter-v0.1.0`. Public npm publication,
repository visibility changes, and hosted CI execution are not claimed.

## Behavioral evidence

At documentation commit `b50ef13`, the full suite passed **293 tests in 16 files**.
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

The following section will receive the clean-checkout command transcripts after
the release harness and repository-hygiene checks are committed. The preceding
results describe the completed implementation checks, not clean-machine proof.

## Limits

- Fixtures are synthetic protocol envelopes. Genuine wallet/facilitator/on-chain
  interoperability has not been tested.
- Windows browser checks use Chromium. Other browser engines, a live Linux
  desktop, and hosted GitHub Actions runs have not been exercised here.
- VHS/asciinema encoding is not run; the requested GIF remains an explicitly
  documented placeholder. The simulation itself is executed.
- The npm name remains unpublished. The README's source commands work before
  publication; its registry command requires the first public release.
- Long-running/high-volume ledger performance, disk exhaustion, and OS crash
  recovery have not been stress-tested. Storage failures preserve traffic and
  can prevent enforcement; hidden redirects, unsupported forms, and encrypted
  streams are also outside complete budget visibility.

All implementation deviations and pending repository-description/public-release
actions are listed at the top of [SPEC-NOTES.md](SPEC-NOTES.md).
