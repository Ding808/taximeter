# Taximeter SDK

`withMeter` wraps a Node.js fetch transport with the same parser, SQLite ledger,
and policy engine used by the proxy. It supports Node 20 or later and ESM. It
does not start a proxy or dashboard, create a payment, or configure a wallet.

Install the registry release with `npm install taximeter`. From a source checkout,
run `npm ci` and `npm run build`, then save the examples at the repository root.
Their `import "taximeter"` statements resolve the package's own built exports.
To try a local build in another project, run `npm pack`, copy the resulting
tarball there, and use `npm install ./taximeter-0.2.0.tgz`.

## Try it locally

After choosing an installation method above, save this complete example as
`sdk-local.mjs`, then run `node sdk-local.mjs`.
It starts a temporary HTTP server on loopback, sends one ordinary request, and
closes both the server and an in-memory ledger. It makes no external requests.

```javascript
import { once } from "node:events";
import { createServer } from "node:http";
import { withMeter } from "taximeter";

const upstream = createServer((request, response) => {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({
    task: request.headers["taximeter-task"],
    agent: request.headers["taximeter-agent"],
  }));
});
upstream.listen(0, "127.0.0.1");
await once(upstream, "listening");
const address = upstream.address();
if (!address || typeof address === "string") {
  throw new Error("Expected a local TCP listener");
}

const metered = withMeter(fetch, {
  db: ":memory:",
  taskId: "research",
  agentId: "agent",
});
try {
  const response = await metered(`http://127.0.0.1:${address.port}/example`, {
    redirect: "error",
  });
  console.log(await response.text());
  console.log(`Payments recorded: ${metered.ledger.events().length}`);
} finally {
  metered.close();
  upstream.closeAllConnections();
  await new Promise((resolve, reject) => {
    upstream.close((error) => error ? reject(error) : resolve());
  });
}
```

Expected output:

```text
{"task":"research","agent":"agent"}
Payments recorded: 0
```

An ordinary request is not a payment. Attribution headers travel with the
request, but a ledger payment appears only when the transport sees a recognized
x402 authorization. A 402 challenge alone also contributes no spend.

## Place the meter inside the payment wrapper

Use `wrapFetchWithPayment(withMeter(fetch, options), client)`. This placement
lets Taximeter inspect the initial challenge and gate each signed replay before
the supplied transport forwards it. Wrapping a payment-enabled fetch on the
outside hides that wrapper's internal replay.

The following ESM factory accepts your application's existing, configured
`x402Client` or `x402HTTPClient`. It neither creates nor receives a private key.
Install the optional integration dependency with
`npm install @x402/fetch@2.25.0`, then save this module as `metered-payment.mjs`.
Taximeter itself does not depend on the official payment client.

```javascript
import { wrapFetchWithPayment } from "@x402/fetch";
import { withMeter } from "taximeter";

/**
 * @param {import("@x402/fetch").x402Client | import("@x402/fetch").x402HTTPClient} client
 * @param {import("taximeter").MeterOptions} [options]
 */
export function createMeteredPaymentFetch(client, options = {}) {
  const transport = withMeter(fetch, options);
  return {
    fetch: wrapFetchWithPayment(transport, client),
    ledger: transport.ledger,
    close: () => transport.close(),
  };
}
```

Pass your existing client and attribution options to
`createMeteredPaymentFetch(client, { taskId: "research", agentId: "agent" })`.
Use the returned `fetch` in place of your existing paid fetch, and call `close`
after all requests have finished. Client setup and authorization remain your
application's responsibility. Configuring the payment client to support a rail
does not add that rail to Taximeter's supported subset.

The factory's parameter types and composition match the published
[@x402/fetch 2.25.0 declarations](https://unpkg.com/@x402/fetch@2.25.0/dist/esm/index.d.mts)
and [transport implementation](https://unpkg.com/@x402/fetch@2.25.0/dist/esm/index.mjs).
The local example and factory were exercised with ordinary loopback traffic;
the integration tests use synthetic x402 authorizations. No wallet or genuine
payment was used to validate these examples.

## Options and lifecycle

`withMeter(fetchImpl, options)` returns a fetch-compatible function with a
`ledger` property and an idempotent `close()` method.

| Option | Default | Meaning |
| --- | --- | --- |
| `db` | Resolved configuration; normally `~/.taximeter/ledger.db` | SQLite path. Use `:memory:` for temporary state. Overrides `config.db` when the wrapper creates the ledger. |
| `config` | Resolved configuration | A partial Taximeter configuration, including budgets and policy. Amounts must be decimal integer strings in atomic units. |
| `ledger` | A new `Ledger` | An existing Taximeter ledger owned by the caller. Its storage path is used instead of `db`. |
| `taskId` | Existing `Taximeter-Task` header, otherwise unattributed | Overrides the task header on each request. Use an HTTP-header-compatible label of 1–256 characters. |
| `agentId` | Existing `Taximeter-Agent` header, otherwise unattributed | Overrides the agent header on each request. Use an HTTP-header-compatible label of 1–256 characters. |

Without an injected ledger, configuration resolves from home/cwd files and
environment, with explicit SDK options taking precedence. See the
[configuration reference](../README.md#configuration). With an injected
`ledger`, the SDK uses built-in defaults plus `config`; it does not load config
files or environment settings. Keep budgets consistent across writers sharing
the same database.

`config.policy.unknownAsset` defaults to `"deny"`. Only network and contract pairs
in Taximeter's offline asset registry are known; payment-supplied symbols and
decimal metadata do not establish trust. To use custom-token budgets, explicitly
set `config.policy.unknownAsset` to `"allow"` and configure the matching contract
and network budget. This permits parsed unknown assets; the default USDC budgets
do not cap them.

The wrapper closes only a ledger it created. For an injected ledger, close all
wrappers after their requests finish, then let the owner close the ledger.
Reusing a closed wrapper passes requests directly to the original transport
without metering. Do not use a closed wrapper for later payments.

Version 0.2.0 upgrades existing ledgers to schema version 2 when opening them.
Source events and outcomes remain unchanged; the added budget index is rebuilt
from those records. Upgrade all writers together. Older 0.1.x clients cannot
reopen a migrated database. `ledger.rebuildCache()` repairs the derived index
from the append-only log inside a transaction.

## Fetch behavior and limits

- Use a Node fetch implementation that accepts standard `string`, `URL`, or
  `Request` inputs. Header objects, header tuples, and `Headers` are supported.
  Request bodies, abort signals, and transport options are preserved.
- The wrapper returns the original upstream `Response`. It does not consume
  its body. It inspects a clone only for legacy 402 challenges, bounded to
  64 KiB and 100 ms. Slow, oversized, malformed, or unsupported challenges pass
  through with a diagnostic.
- Native fetch or a custom transport can follow redirects internally. Those
  hops are invisible to Taximeter's preflight policy checks. A redirected
  response produces a diagnostic, but its destination may already have received
  a payment header. Use `redirect: "error"` on host-sensitive fetch calls, or a
  transport that exposes each hop separately. Taximeter preserves your redirect
  setting. Redirected v1 challenges are not cached against the initial URL.
- Internal retries hidden inside a custom transport have the same visibility
  limit. Put payment retries outside the metered transport, as in the official
  wrapper composition above.
- Recognized authorizations reserve capacity before forwarding. A policy denial
  returns a 402 JSON response with `error: "blocked_by_taximeter"`, `reason`,
  `budget`, `spent`, and `remaining`, and records a blocked event. The enclosing
  payment client can apply its own response handling or throw its own error.
- A parsed unknown asset is denied by default with `reason: "unknown_asset"`,
  `budget: null`, `spent: "0"`, and `remaining: null`. Unsupported or unparseable
  payment formats still pass through with a diagnostic.
- If the transport throws after forwarding an authorization, the original
  error is rethrown and the authorization remains reserved with unknown
  settlement. Missing settlement evidence has the same conservative treatment.
  Upstream-reported settlement is not independent on-chain verification.
- Storage failures pass traffic through and emit a local stderr warning.
  Enforcement requires working storage. Unsupported payment formats also pass
  through with a diagnostic; this is a cooperative meter rather than an
  isolation boundary.

The initial adapter meters exact EVM EIP-3009 payments: legacy v1 on Base and
Base Sepolia, and v2 with EVM CAIP-2 networks. Permit2, ERC-7710, other schemes,
and other rails remain unmetered. Known Base/Base Sepolia USDC uses six decimal
places; explicitly allowed unknown tokens remain exact atomic units. Budgets and totals are
separate for every network and asset. See
[protocol notes](https://github.com/Ding808/taximeter/blob/main/SPEC-NOTES.md) for
wire formats, challenge correlation, idempotency, and settlement rules.

## Read the same ledger from the CLI

For persistent state, use `db: "./agent.db"` in your SDK options. Run
`npx taximeter report --db ./agent.db --json` to inspect exact totals, or
`npx taximeter export --db ./agent.db --csv ./agent.csv` to create a statement.
Export files must not already exist. Monetary CSV `amount` values are counted
contributions; blocked and known failed rows contribute zero. Sum them
separately by network and asset.

Run `npx taximeter start --db ./agent.db` to view that ledger in the local
dashboard. The SDK continues to call its own supplied transport; the CLI proxy
and `config.upstream` do not reroute SDK requests. Stop all SDK writers before
using `npx taximeter reset --db ./agent.db --yes`, which archives the ledger.
