# Taximeter

A taximeter for your AI agents.

```sh
npx taximeter start
```

Taximeter records supported agent payments, checks budgets before forwarding them,
and keeps an exact local ledger. **This is the unpublished v0.1.0 source release.**
The registry command above becomes available after publication; the three-command
source quickstart below works today. Requires Node 20 or newer.

## A 20-second demo

![Taximeter allows 20 payments and blocks payment 21](docs/demo.gif)

This local recording shows 20 payments passing and payment 21 being blocked at
an exact total of 140 atomic units. It uses synthetic x402 envelopes and never
moves money. [Record the demo](docs/RECORDING.md) with the included simulation.

## Why

Visa moves money; Ramp organizes the spending around it.
Payment rails similarly move agent payments, while Taximeter keeps a durable local
record of which task spent what.
It adds exact rolling budgets, attribution, and a statement you can keep.

## Quickstart

Open a terminal in this source checkout, with Node 20+ and npm installed.

1. Install the pinned dependencies.

   ```sh
   npm ci
   ```

2. Build the CLI and dashboard.

   ```sh
   npm run build
   ```

3. Start the meter with its default configuration.

   ```sh
   node dist/cli/index.js start
   ```

You should now see:

```text
Taximeter 0.1.0
Proxy: http://127.0.0.1:8402
Dashboard: http://127.0.0.1:8403
Point an HTTP-proxy-aware agent at http://127.0.0.1:8402.
HTTPS CONNECT is unmetered; use --upstream or withMeter for HTTPS payments.
```

Open [the local dashboard](http://127.0.0.1:8403). It explains how to connect an
agent before the first payment arrives. Stop the process with Ctrl+C.
The prebuilt npm package starts directly; installing it does not build the frontend.
Dependency download time depends on the connection. See [measured verification](VERIFICATION.md).

Choose the connection mode your agent supports:

| Mode | How to connect | What is visible |
| --- | --- | --- |
| HTTP forward proxy | Configure the client's HTTP proxy as `http://127.0.0.1:8402`. `HTTP_PROXY` works only in clients that honor it. | Plain HTTP payment requests and replies. |
| Explicit upstream | Start with `--upstream` set to the real HTTP(S) API origin, then use the local proxy URL as the agent's API base URL. | HTTP or HTTPS upstream payments, without intercepting TLS. |
| SDK | Put `withMeter(fetch, options)` **inside** the payment wrapper. See [SDK examples](docs/SDK.md). | Requests made through the supplied transport. |
| HTTPS CONNECT | A proxy-aware HTTPS client may open a tunnel. | Encrypted bytes pass through, with an unmetered diagnostic. Payment headers are invisible. |

In upstream mode, `/data` replaces any path prefix in the configured upstream URL.
Use the API origin as the upstream and keep its path in the request. Native fetch
does not universally honor proxy environment variables. SDK transports can also
follow redirects or retry internally: these hidden requests are outside host policy
checks. Use `redirect: "error"` when each destination must be checked.

From the checkout, use `node dist/cli/index.js` in place of the installed `taximeter`
or `txm` command. The CLI provides:

| Command | Result |
| --- | --- |
| `taximeter start` | Proxy on port 8402; dashboard on port 8403. |
| `taximeter report` | Exact totals, separately by network and asset. |
| `taximeter report --json` | Totals as integer strings. Filters: `--task`, `--agent`, `--host`. |
| `taximeter export --csv statement.csv` | A new CSV file; refuses to overwrite an existing file. |
| `taximeter export --json statement.json` | Event history, raw authorizations, and totals. With no format, JSON goes to stdout. |
| `taximeter export --invoice statement.html` | A printable HTML spending statement. |
| `taximeter doctor` | Local configuration and SQLite checks; no network probes. |
| `taximeter reset --yes` | Archives the ledger. Stop **all CLI and SDK writers** first. |

## How it works

```text
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

The meter recognizes x402 v1/v2 `exact` EVM EIP-3009 authorizations and reserves
their amount before forwarding the payment replay.
Policy evaluation and reservation share one SQLite transaction, so concurrent
payments cannot all consume the same remaining capacity.
Append-only payment, outcome, and diagnostic records derive every total with BigInt.
The local dashboard polls that ledger every second and exports the same counted amounts.

An initial 402 challenge is an offer, not spend. Reported settlement counts as
confirmed; missing evidence stays **unknown** and remains reserved. Known failures
and blocked attempts do not contribute to totals. Taximeter does not independently
verify the upstream's settlement report.

Repeated EIP-3009 authorizations count once across retries, using network, contract,
payer, nonce, amount, recipient, and validity bounds. Conflicting authorization
details receive separate reservations. Each unresolved forwarding attempt keeps
capacity reserved; an old unconfirmed retry must reacquire capacity in the current
window. [Protocol notes](SPEC-NOTES.md) explain these rules and the supported subset.

CSV `amount` is the counted contribution, including zero for blocked/known failed
rows. `authorizedAmount` retains the original amount. Sum `amount` with BigInt
**separately by network and asset** to reproduce dashboard ledger totals; a rolling
budget figure can differ from the all-time ledger total. Import monetary CSV columns
as text to prevent a spreadsheet application from rounding them.

## Configuration

No file is required. Start from [the example](taximeter.config.example.json) when
needed. Precedence, highest first: flags, environment, explicit `--config` file,
`taximeter.config.json` in the working directory, `~/.taximeter/config.json`, defaults.
Layers merge by scope; unspecified sibling settings remain intact. Unknown keys and
invalid values are rejected with Zod.

| Option | Default | Meaning |
| --- | --- | --- |
| `budgets.perTask` | `{"amount":"5000000","asset":"USDC"}` | 5 USDC per task, all time. `null` disables it. |
| `budgets.perAgent` | `{"amount":"50000000","asset":"USDC","window":"24h"}` | 50 USDC per agent in a rolling 24 hours. `null` disables it. |
| `budgets.global` | `{"amount":"100000000","asset":"USDC","window":"24h"}` | 100 USDC per network/asset in a rolling 24 hours. `null` disables it. |
| Each budget's `amount` | Scope default above | Nonnegative integer string in atomic units, at most 78 digits. |
| Each budget's `asset` | `USDC` | Trusted local symbol or exact contract address. |
| Each budget's `network` | Omitted | Optional exact network such as `eip155:8453`; otherwise evaluate each network separately. |
| Each budget's `window` | Scope default above | `1h`, `24h`, `7d`, or `30d`; omitted means all time. |
| `policy.allowHosts` | `[]` | Empty allows all; otherwise exact case-insensitive hostname matches. No wildcards. |
| `policy.denyHosts` | `[]` | Exact denied hostnames; denial takes priority. |
| `policy.allowPayTo` | `[]` | Empty allows all recipients; otherwise exact case-insensitive addresses. |
| `policy.maxSinglePayment` | `"1000000"` | One USDC per authorization by default; `null` disables the cap. |
| `policy.maxSingleAsset` | `USDC` | Asset to which the single-payment cap applies. |
| `ports.proxy` | `8402` | Loopback HTTP listener; `0` selects an available port. |
| `ports.dashboard` | `8403` | Loopback dashboard listener; `0` selects an available port. |
| `db` | `~/.taximeter/ledger.db` | SQLite path; relative paths resolve against the working directory. |
| `upstream` | Omitted | HTTP(S) destination for explicit local base-URL mode; no URL credentials. |

All commands accept `--db` and `--config`. Start also accepts `--proxy-port`,
`--dashboard-port`, and `--upstream`. Environment overrides are `TAXIMETER_DB`,
`TAXIMETER_PORT`, and `TAXIMETER_DASHBOARD_PORT`.

Missing task/agent labels share an **Unattributed** bucket. Supply `Taximeter-Task`
and `Taximeter-Agent` headers, or SDK options. The local USDC registry recognizes
Base and Base Sepolia; other contracts remain separate atomic-unit balances with
unknown decimals. Default USDC budgets do not cap unknown assets.

A denied replay receives HTTP 402 before it reaches the upstream. For a cap of
140 atomic units already fully consumed, the response is:

```json
{
  "error": "blocked_by_taximeter",
  "reason": "global_budget",
  "budget": "140",
  "spent": "140",
  "remaining": "0"
}
```

Reasons are `host_denied`, `host_not_allowed`, `recipient_not_allowed`,
`max_single_payment`, `per_task_budget`, `per_agent_budget`, and `global_budget`.
Host/recipient denials have `budget: null` and `remaining: null`.

## What this is not

- A wallet or facilitator: it never holds keys or funds, signs, verifies, or settles payments.
- A cloud service: no accounts, telemetry, analytics, or external font requests.
- A multi-user service: no authentication, tenancy, or RBAC. Both listeners bind to loopback.
- A universal payment parser: Permit2, ERC-7710, non-EVM rails, Stripe MPP, and cards are outside v0.1.0.
- A security boundary against a bypassing agent: unsupported traffic passes through with diagnostics. CONNECT and post-upgrade frames are unmetered. Storage failure also passes traffic and prints a warning, so budget guarantees require working storage.

Raw payment authorizations stay in the local audit ledger and JSON export. Treat
them as sensitive. [Security guidance](SECURITY.md) describes the boundary and how
to report a problem.

## Contributing / license

Read [CONTRIBUTING.md](CONTRIBUTING.md), [the decisions](DECISIONS.md), and
[the specification](SPEC.md). Test and release evidence is in [VERIFICATION.md](VERIFICATION.md).
Licensed under [MIT](LICENSE).
