# Record the live testnet demo

The shipped `demo.gif` records the actual Taximeter CLI handling a Base Sepolia
x402 payment, followed by a second signed request blocked by its budget. The
official client signs a disposable test-wallet authorization, the official
Express middleware calls the public facilitator, and a separate RPC check
verifies the transfer. Taximeter itself never signs or queries the chain.

The seller is a local HTTP server. This run demonstrates explicit upstream mode,
not payment visibility inside HTTPS CONNECT, live SDK mode, or mainnet settlement.
Testnet tokens have no financial value. L2 confirmations are not Ethereum finality.

## Reproduce the payment

Follow the [live testnet example](../examples/live-testnet/README.md) to install
its pinned dependencies, prepare disposable local wallets, and obtain test USDC.
Its `check` command confirms funding without reading a key or making a payment.
From `examples/live-testnet`, the recorded operation is:

```sh
node run-live.mjs
```

Each invocation deliberately attempts one `1000`-unit payment and one request
that should be blocked. The harness requires a successful canonical receipt,
matching block membership and Transfer metadata, sufficient chain height, exact
balance changes, unchanged seller settlement counts after blocking, and matching
ledger/dashboard totals. It prints success only after both local servers close.
It never automatically retries an uncertain paid operation. Inspect the retained
transaction and ledger before invoking it again after a failure.

## Captured Windows session

The recording was made on 2026-09-09 UTC (2026-09-08 local time) in `cmd.exe` through
Windows ConPTY using [node-pty 1.1.0](https://github.com/microsoft/node-pty).
The recorder types the live command, captures the original terminal output and
timing, waits for the success marker, and checks the shell's zero exit status.
The terminal is 116 columns by 34 rows. The external recording checkout uses
fixed local paths; the committed example resolves the same build relative to
its own directory.

The reviewed [source capture](evidence/live-0.2.2.cast) and
[redacted payment evidence](evidence/base-sepolia-0.2.2.json) are committed for
inspection. Keys, signed headers, raw authorizations, SQLite databases, and
recording dependencies are excluded. Only `docs/demo.gif` ships in the npm package.
No output has been fabricated or replaced.

[agg 1.9.0](https://github.com/asciinema/agg/releases/tag/v1.9.0) renders the capture
using Consolas at 18 px, line height 1.1, the GitHub dark theme, and a 20 fps cap.
Original pauses are retained; only the last frame is held longer for readability.
FFmpeg converts the rendered GIF to H.264 with padding for even pixel dimensions.

To render the committed capture with agg installed, create `tmp/` and run from
the repository root:

```sh
agg --font-family Consolas --font-size 18 --line-height 1.1 --theme github-dark --fps-cap 20 --idle-time-limit 30 --last-frame-duration 4 docs/evidence/live-0.2.2.cast tmp/live-demo.gif
```

That command uses a four-second final pause. The shipped rendering adjusts the
final hold to the duration recorded in [verification](../VERIFICATION.md#022-live-testnet-payment-and-first-connect-notice).
Review the result before replacing `docs/demo.gif`; the package must remain under 2 MB.

## Capture a new run with asciinema

On a system supported by [asciinema](https://docs.asciinema.org/), prepare and fund
the example first. From `examples/live-testnet`:

```sh
asciinema rec --cols 116 --rows 34 --command "node run-live.mjs" live.cast
agg live.cast live.gif
```

This is a documented alternative, not the tool used for the verified Windows
capture. Never type keys or account credentials into a recorded terminal. The
example loads the disposable key privately and prints public evidence only.

## Offline simulation

The earlier synthetic demonstration remains available without a wallet or
network access. From a built source checkout:

```sh
node docs/demo.mjs
```

It allows 20 fixture payments and blocks payment 21 at exactly `140` atomic units.
Its signatures and settlement reports are synthetic. For a separate VHS capture,
create `tmp/`, then run `vhs docs/demo.tape`; it writes `tmp/offline-demo.gif`.
VHS and asciinema are optional development tools and are not package dependencies.
