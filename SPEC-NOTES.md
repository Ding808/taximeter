# Protocol verification notes

Research date: **2026-09-08**. These notes record the protocol baseline read before
implementation, the supported subset, and corrections to [SPEC.md](SPEC.md).
Amounts below are atomic integer strings. Taximeter does not sign, verify, or
settle a payment.

## Implemented deviations and release limits

This is the release's consolidated deviation inventory. The detailed wire shapes
and source evidence follow below; these limits apply to both the CLI and SDK
unless a row names one intake specifically.

| Area in the brief | Implemented behavior and reason |
| --- | --- |
| Demo placeholder (§6) | The original placeholder is replaced by a 20-second Windows ConPTY recording rendered by agg. The simulation runs locally; no payment is signed or settled. Only the GIF ships in the package; capture tools and intermediate files are local development artifacts. |
| Broad x402 support (§2, §4) | Support HTTP v1/v2 `exact` EVM **EIP-3009** authorizations. v1 maps only `base` and `base-sepolia`; v2 accepts positive `eip155:<chain-id>` identifiers. Permit2, ERC-7710, other transfer methods, schemes, and networks are diagnosed and passed through. Their different authorization semantics cannot safely share this parser. |
| Generic 402 JSON and complete replay context (§0, §2) | v1 reads the challenge body and `X-PAYMENT`; v2 reads `PAYMENT-REQUIRED` and `PAYMENT-SIGNATURE`. v1 replays omit asset context and need a previously observed, unambiguous challenge. v2 replays carry `accepted`. A status of 402 alone does not establish x402. |
| Unbounded challenge observation (§4) | v1 correlation is local to each intake instance, with a five-minute TTL and at most 1,000 cached contexts. The key binds actual URL, method, task, agent, Authorization, and Cookie. Bodies are limited to 64 KiB; payment header text is limited to 65,536 characters. The proxy taps the streaming response without delaying delivery; the SDK additionally limits its cloned body observation to 100 ms. Missing, expired, oversized, slow, compressed proxy bodies, and ambiguous challenges cannot be metered reliably and pass through with a diagnostic. |
| Token metadata in every event (§3) | Only Base and Base Sepolia USDC have trusted, static six-decimal metadata. Other assets retain exact amounts with `decimalsKnown: false` and an internal `decimals: 0` placeholder; displays say **atomic units**, not zero-decimal tokens. No RPC, token-list, or price lookup runs at runtime. |
| One USDC balance and scalar maximum (§3) | Every total and budget is scoped separately by normalized network and contract. Symbol budgets match the local registry. `maxSingleAsset`, default `USDC`, scopes `maxSinglePayment`; unknown assets do not inherit a misleading one-USDC threshold. Optional budget `network` narrows a rule further. |
| One `events` table and the original event fields (§3) | Keep immutable events and add append-only `outcomes` and `diagnostics` tables. Internal fields include `paymentKey`, `decimalsKnown`, `settlementStatus`, `settlement_unknown`, and derived `attemptedAt`; outcomes identify each forwarding attempt. These are Taximeter fields, not invented x402 wire fields. |
| Deduplication by nonce/transaction/resource within a small window (§4) | A persistent key binds network, asset, payer, nonce, amount, recipient, and both authorization validity bounds. Signature, resource, and observation time are excluded. The same authorization counts once across retries and URLs; changed immutable authorization details retain a separate conservative reservation. |
| Observed payments equal settled spend (§3, §4) | Reserve recognized authorizations synchronously in the same SQLite transaction as policy evaluation, before forwarding. Upstream-reported success is confirmation evidence, not independent settlement verification. Any confirmed attempt wins; otherwise any unresolved attempt retains capacity. Only an authorization whose known attempts all failed contributes zero. |
| Retry timing and upstream failure (§4) | `attemptedAt` separates the latest unconfirmed forwarding attempt from immutable `ts`. An unconfirmed replay outside a rolling budget window must reacquire capacity. Missing settlement headers, disconnects, and unconfirmed 5xx responses remain unknown; an explicit matching success header can confirm even on a non-2xx response. |
| Storage failure while preserving traffic (§4) | Runtime ledger/policy-intake storage failures fail open and emit a visible local warning plus a diagnostic when storage permits. A failed outcome write leaves its original reservation in place. Budget enforcement requires working storage; startup/configuration failures still fail visibly rather than claiming a working service. |
| Universal zero-code proxy support (§2) | Clients must actually honor their proxy configuration. HTTPS CONNECT is an encrypted byte tunnel and is explicitly unmetered; Taximeter installs no certificate authority. An explicit localhost route with `--upstream`, or the SDK inside the payment wrapper, can inspect HTTP payment messages sent to HTTPS upstreams. |
| Explicit base URL semantics (§2) | Origin-form requests require `upstream`. Its **origin** supplies the destination; the incoming path replaces any configured upstream path prefix. For example, upstream `https://api.example/v1` plus `/weather` forwards to `https://api.example/weather`. Leading `//` stays on the configured origin. Original encoded paths and query text are preserved separately from URL authority validation. |
| Byte-identical forwarding and upgraded protocols (§4) | Preserve request/response payload bytes, duplicate end-to-end headers, and trailers, while rebuilding HTTP hop-by-hop headers and transfer framing as a proxy must. Recognized signed HTTP upgrade handshakes can be gated; subsequent upgraded stream frames are unmetered and diagnosed. CONNECT and upgrades do not imply inspection of payments hidden in their streams. |
| Wrapping an arbitrary payment-enabled fetch (§2) | Compose `wrapFetchWithPayment(withMeter(fetch, options), client)` so each signed replay reaches the meter. The supplied transport's internal retries and redirects are invisible. A response marked `redirected` emits a visibility diagnostic and is never cached as a v1 challenge for the original URL. Host-sensitive callers can request `redirect: "error"` or expose each hop. The wrapper returns the original response and never consumes a request body. |
| Configuration precedence (§3) | Extend precedence to flags > `TAXIMETER_*` environment > explicit `--config` file > cwd file > home file > defaults. The explicit file layers over automatic files. Environment support is exactly `TAXIMETER_DB`, `TAXIMETER_PORT`, and `TAXIMETER_DASHBOARD_PORT`. Relative database paths resolve from cwd; `~` expands locally. |
| Additional configuration choices (§3) | `upstream` supports explicit routing; budget windows support `1h`, `24h`, `7d`, and `30d`; nullable budgets and `maxSinglePayment` disable their respective rules; port `0` requests an available port. Config and CLI options remain strict Zod inputs. Host/recipient allowlists are exact, case-insensitive matches, not wildcard patterns. |
| Reset and local checks (§2) | `reset --yes` archives rather than deletes the ledger and acquires an atomic CLI lock. All SDK writers must be stopped separately; the lock coordinates CLI instances only. Read-only commands use an empty in-memory ledger when the path is absent. `doctor` checks local configuration and SQLite without requesting any upstream; it does not certify wallet/facilitator access or write permission for a nonexistent database path. |
| Dashboard session and hero (§5) | Timeline shows the current UTC hour and preceding 23 hourly buckets, not an arbitrary process session. The Now hero shows the selected asset's active global budget window; all-time ledger totals are labeled separately. Assets and networks never share one monetary chart total. The latest 30 events and 10 diagnostics are shown; raw payment JSON remains available in JSON export. |
| Thirty visible rows and Google Fonts (§5) | The event stream keeps 30 recent rows, with scrolling where screen height or width requires it. System grotesque and monospace stacks replace runtime Google Fonts requests to honor the network invariant. Complete light/dark tokens and exact BigInt-derived chart geometry are retained. |
| Export and invoice format (§2, §5) | CSV includes all derived payment rows: `amount` is the counted contribution, while `authorizedAmount` preserves the original proposal. Blocked and wholly failed payments contribute zero. Sum each network/asset separately to reproduce the dashboard ledger totals. The invoice is standalone printable HTML, with no PDF renderer, exchange-rate conversion, tax calculation, or settlement attestation. |
| Module and dependency choices (§7) | Ship ESM only, with no optional CommonJS build. Pin `better-sqlite3` 12.8.0 to preserve Node 20 support; version 13 requires Node 22. Exact pins and the audited esbuild override are recorded in `package.json` and the lockfile. |
| Fixture realism and financial claims (§7) | Fixture envelopes follow primary protocol examples but all authorizations, signatures, and settlement responses are synthetic. Tests exercise parsing, transport, budget races, failures, and exact accounting; no real transfers, wallet signing, facilitator call, or independent chain verification is performed. |
| Public installation and repository tagline (§1, §6) | The initial registry check returned `E404`; npm ownership was subsequently established with `0.1.0`. The release package uses `0.1.1`, and the README provides both `npx taximeter start` and source-build instructions. Fresh-directory startup from the local tarball is documented in `VERIFICATION.md`. Repository visibility is a maintainer-managed setting. The intended repository description is **A taximeter for your AI agents.** |

These limitations make Taximeter a cooperative local meter. An agent that
bypasses the intake, uses an unsupported payment method, or hides a replay
inside a transport can bypass its budget checks. No supported flow holds funds,
private keys, or payment-signing authority.

## Primary sources and published packages

The requested [Coinbase repository README](https://github.com/coinbase/x402/blob/main/README.md)
now identifies Coinbase's repository as a development fork and points to the
[x402 Foundation repository](https://github.com/x402-foundation/x402) as the project
home. The requested files were read, together with the Foundation specifications,
the HTTP transport specification, documentation, and actual npm tarballs:

- [Protocol v1](https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v1.md)
  and [protocol v2](https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md).
- [Requested Coinbase v2 specification](https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md)
  and [exact EVM scheme](https://github.com/coinbase/x402/blob/main/specs/schemes/exact/scheme_exact_evm.md).
- [HTTP v2 transport](https://github.com/x402-foundation/x402/blob/main/specs/transports-v2/http.md).
- [x402 documentation](https://docs.x402.org/introduction),
  [migration guide](https://docs.x402.org/guides/migration-v1-to-v2),
  [network and token support](https://docs.x402.org/core-concepts/network-and-token-support),
  [exact scheme](https://docs.x402.org/schemes/exact), and
  [payment identifier extension](https://docs.x402.org/extensions/payment-identifier).

All four published packages resolved to **2.25.0**. Their tarballs were downloaded
with `npm pack`, extracted outside the repository, and their READMEs, package
exports, and relevant exported declarations were inspected. These are research
inputs, not runtime dependencies of Taximeter.

| Package | Published API inspected | Relevant finding |
| --- | --- | --- |
| [@x402/core 2.25.0](https://www.npmjs.com/package/@x402/core/v/2.25.0) | `types`, `types/v1`, `schemas`, `client`, `http`, `server` | Both protocol versions; header helpers; optional fields differ between nominal types and runtime schemas. |
| [@x402/evm 2.25.0](https://www.npmjs.com/package/@x402/evm/v/2.25.0) | Main types, `exact/client`, `exact/server`, `exact/facilitator`, `v1` | EIP-3009 and Permit2 payloads; legacy network map; local default-asset metadata. |
| [@x402/fetch 2.25.0](https://www.npmjs.com/package/@x402/fetch/v/2.25.0) | `wrapFetchWithPayment`, `wrapFetchWithPaymentFromConfig` | The supplied fetch is called for the initial request and each signed replay. |
| [@x402/express 2.25.0](https://www.npmjs.com/package/@x402/express/v/2.25.0) | `paymentMiddleware`, `paymentMiddlewareFromConfig`, `paymentMiddlewareFromHTTPServer`, `ExpressAdapter` | Middleware verifies and settles; Taximeter must not adopt that facilitator role. |

The pinned package declarations can also be inspected at
[@x402/core types](https://unpkg.com/@x402/core@2.25.0/dist/esm/types/index.d.mts),
[@x402/core v1 types](https://unpkg.com/@x402/core@2.25.0/dist/esm/types/v1/index.d.mts),
[@x402/evm types](https://unpkg.com/@x402/evm@2.25.0/dist/esm/index.d.mts),
[@x402/fetch types](https://unpkg.com/@x402/fetch@2.25.0/dist/esm/index.d.mts), and
[@x402/express types](https://unpkg.com/@x402/express@2.25.0/dist/esm/index.d.mts).

## HTTP wire formats

HTTP header names are case-insensitive. Payment headers contain Base64-encoded
UTF-8 JSON, not the signature alone. A response is not necessarily x402 just
because its status is 402.

| Message | v1 | v2 |
| --- | --- | --- |
| Payment requirements | JSON response body with `x402Version: 1` | `PAYMENT-REQUIRED` response header with `x402Version: 2` |
| Signed payment replay | `X-PAYMENT` request header | `PAYMENT-SIGNATURE` request header |
| Settlement result | `X-PAYMENT-RESPONSE` response header | `PAYMENT-RESPONSE` response header |

In v2, the response body is application content. It may be empty, JSON, HTML, or
another media type. It is not the authoritative location of payment requirements.
The published HTTP client checks `PAYMENT-REQUIRED` first and uses a v1 body only
as the compatibility fallback. It recognizes both settlement header names.
[HTTP transport source](https://github.com/x402-foundation/x402/blob/main/specs/transports-v2/http.md)

### v1 envelopes

The following notation uses `?` for optional fields and describes the wire shape,
not a TypeScript import from a payment SDK:

```text
PaymentRequiredV1 {
  x402Version: 1,
  error?: string,
  accepts: PaymentRequirementsV1[]
}

PaymentRequirementsV1 {
  scheme: string,
  network: string,
  maxAmountRequired: string,
  resource: string,
  description: string,
  mimeType?: string,
  outputSchema?: object | null,
  payTo: string,
  maxTimeoutSeconds: number,
  asset: string,
  extra?: object | null
}

PaymentPayloadV1 {
  x402Version: 1,
  scheme: string,
  network: string,
  payload: object
}
```

The v1 specification's field table requires `error`; the published 2.25.0 Zod
schema makes it optional. Its `mimeType`, `outputSchema`, and `extra` are also
optional even though the nominal declaration is stricter. Taximeter follows the
compatible runtime shape for these fields. `accepts` must contain at least one
option; `maxTimeoutSeconds` is a positive number.

Legacy networks use names such as `base` and `base-sepolia`. A v1 signed replay
does **not** carry `asset`, `resource`, `accepted`, or `maxAmountRequired` at its
top level. The preceding challenge supplies that missing context.
[v1 source](https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v1.md)

### v2 envelopes

```text
ResourceInfo {
  url: string,
  description?: string,
  mimeType?: string
}

PaymentRequirementsV2 {
  scheme: string,
  network: string,
  amount: string,
  asset: string,
  payTo: string,
  maxTimeoutSeconds: number,
  extra?: object | null
}

PaymentRequiredV2 {
  x402Version: 2,
  error?: string,
  resource: ResourceInfo,
  accepts: PaymentRequirementsV2[],
  extensions?: object | null
}

PaymentPayloadV2 {
  x402Version: 2,
  resource?: ResourceInfo,
  accepted: PaymentRequirementsV2,
  payload: object,
  extensions?: object | null
}
```

The v2 amount field is `amount`, not v1's `maxAmountRequired`. The selected option
is `accepted`, not `accepts`. The required-response resource is a separate object;
the replay's resource is optional. Networks use CAIP-2 identifiers such as
`eip155:8453` and `eip155:84532`.

Published schemas accept `null` for optional v2 resource/error metadata and
normalize it to absence. They also permit resource metadata `serviceName`, `tags`,
and `iconUrl`. These optional fields and unknown extensions do not determine
spend. The original parsed JSON is retained for auditing, and forwarding does
not reserialize or rewrite the payment payload.
[v2 source](https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md)

### Exact EVM EIP-3009 payload, both versions

```text
payload {
  signature: hex-string,
  authorization: {
    from: EVM-address,
    to: EVM-address,
    value: unsigned-decimal-integer-string,
    validAfter: unsigned-decimal-integer-string,
    validBefore: unsigned-decimal-integer-string,
    nonce: 32-byte-hex-string
  }
}
```

`value` is the signed token amount. `validAfter` and `validBefore` are Unix seconds
represented as strings; they are not the observation timestamp. `from` is the
payer and `to` is the recipient. An exact payment's signed `value` must match the
selected requirement's amount; its recipient must match `payTo`. Comparisons of
EVM addresses are case-insensitive. Parsing these relationships is not signature
verification.

The scheme document describes a 65-byte EOA signature, while published
`ExactEIP3009Payload` declares `signature?` and the implementation supports smart
account signature paths. A monitor must not assume every supported signature is
exactly 65 bytes. Unsupported or structurally unrecognized payloads remain
transparent traffic, with a diagnostic.
[Exact EVM source](https://github.com/coinbase/x402/blob/main/specs/schemes/exact/scheme_exact_evm.md)

The same exact-scheme source also describes Permit2
(`payload.permit2Authorization` with `permitted.token`, `permitted.amount`, `from`,
`spender`, decimal `nonce`, `deadline`, and `witness.to`/`witness.validAfter`) and
ERC-7710 (`delegationManager`, `permissionContext`, `delegator`). Published EVM
2.25.0 types include EIP-3009 and Permit2. These are distinct payload formats, not
aliases for `authorization`. Taximeter's initial adapter does not meter them.

### Settlement responses

Both header generations decode to an object with the following fields. There is
no required `x402Version` in this object:

```text
SettleResponse {
  success: boolean,
  transaction: string,
  network: string,
  payer?: string,
  errorReason?: string,
  errorMessage?: string,
  amount?: unsigned-decimal-integer-string,
  extensions?: object,
  extensionResponses?: object,
  extra?: object
}
```

`transaction` is the wire field. Taximeter maps it to internal `txHash`; it does
not search for an invented wire `txHash`. Failed settlement may use an empty
transaction string. v1 uses legacy network names; v2 uses CAIP-2. Optional
`amount` appears in current v2 types for schemes whose settlement differs from
their authorization; it is not permission to treat `upto` as `exact`. Published
types make `payer` optional in both versions, despite the older v1 table.
[Settlement source](https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md)

The monitor considers settlement headers on all response statuses. A signed
replay, HTTP 200, or transaction-looking string alone is not independently
verified settlement. A recognized success is described as **reported settled**.
Malformed, missing, or inconsistent settlement evidence remains unknown.

## Supported subset and accounting decisions

1. **Versions and networks.** Meter v1 and v2 HTTP `exact` EVM EIP-3009 payments.
   Normalize v1 `base` to `eip155:8453` and `base-sepolia` to `eip155:84532`.
   Other legacy names are outside the first implementation's mapping. v2 accepts
   EVM CAIP-2 networks. Other schemes, transfer methods, networks, and versions
   pass through with a diagnostic. This bounded subset supports the common USDC
   flow without pretending to understand different authorization semantics.
2. **Challenge correlation.** v1 requires an observed compatible challenge.
   Correlation uses actual URL, method, task, agent, Authorization, and Cookie,
   with a five-minute TTL and 1,000-context capacity. It then matches scheme,
   network, recipient, and atomic amount.
   Ambiguous asset choices must not be guessed. A v2 replay can supply its own
   selected requirements, so the initial 402 exchange need not have been seen.
   Host policy uses the actual upstream URL, not an untrusted advertised URL.
   The SDK does not cache a response marked `redirected` under the original URL.
3. **Asset identity.** Totals and budget windows are separate for every normalized
   network and asset contract. An asset symbol is a label, not an identity.
   Case-normalized EVM addresses avoid duplicate groups for checksum variants.
4. **Decimals.** Neither protocol envelope provides reliable decimals or ticker
   metadata. `extra.name` and `extra.version` are EIP-712 domain fields, not a
   verified symbol/decimals pair. Use a local registry for Base and Base Sepolia
   USDC only. Unknown assets retain exact atomic units, `decimalsKnown: false`,
   and an internal `decimals: 0` placeholder; the UI labels them as atomic units.
   It must not claim that the token has zero decimals. There are no runtime RPC
   or metadata lookups.
5. **Local USDC registry.** The six-decimal entries are Base
   `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` and Base Sepolia
   `0x036CbD53842c5426634e7929541eC2318f3dCF7e`, as documented in the
   [official asset table](https://docs.x402.org/core-concepts/network-and-token-support).
   An arbitrary contract advertising `name: "USDC"` does not join these groups.
6. **Budget asset scope.** The brief's scalar `maxSinglePayment` defaults to
   verified USDC, made explicit through `maxSingleAsset` with default `USDC`.
   Symbol budgets match trusted local registry entries and are evaluated
   separately for each network/asset pair. There is no cross-chain combined
   dollar balance and no exchange-rate conversion.
7. **Authorization and outcomes.** A challenge is an offer, not spend. A forwarded
   recognized authorization consumes conservative budget capacity before the
   asynchronous upstream request completes. Append-only outcome observations
   distinguish reported settlement, known failure, and unknown settlement.
   Outcomes retain separate attempt identities. Confirmation on any attempt
   wins; otherwise any unresolved attempt retains capacity. Only wholly failed
   attempts release a payment's contribution. Missing settlement evidence, a
   disconnect, or an unconfirmed upstream 5xx after forwarding does not silently
   release that capacity. `attemptedAt` permits an unconfirmed retry outside a
   rolling window to reacquire capacity without rewriting the original event.
8. **Idempotency.** The principal EIP-3009 identity includes network, asset,
   payer, and nonce, bound to amount, recipient, `validAfter`, and `validBefore`.
   Repeated observations of that authorization count once,
   including observations under a different resource. Nonce alone would collide
   across payers/contracts; transaction hash alone can collapse different
   transfers in one transaction. Resource and wall-clock time alone are not a
   reliable payment identity. The optional protocol payment-identifier extension
   is preserved but is not trusted to override an EIP-3009 authorization identity.
   Signature bytes are not part of the key. Conflicting immutable authorization
   details receive separate conservative reservations rather than a free replay.
9. **Concurrency.** Policy evaluation and reservation must be one synchronous
   operation before forwarding. Otherwise concurrent requests can all observe
   the same old total. Totals derive from the event log; settlement observations
   do not mutate earlier rows.
10. **Transparency boundary.** Unsupported or malformed traffic is forwarded
    with its payload unchanged and `parse_failed` diagnostics. Storage failures
    also fail open, with a visible local warning; enforcement needs working
    storage. Therefore this is a cooperative
    local meter, not a security boundary against an agent deliberately bypassing
    the proxy or using an unsupported payment form. Raw audit payloads are
    payment authorizations, not private keys; the ledger is local state.

## Additional protocol corrections relative to the brief

The comprehensive implementation inventory is at the top of this file. These
additional corrections concern the research premise itself:

| Brief assumption or omission | Resolution |
| --- | --- |
| Coinbase repository is the primary project home. | Read the requested files and follow the README's Foundation pointer; preserve source links and research date above. |
| Nominal TypeScript declarations are the only accepted wire shape. | Published 2.25.0 runtime schemas permit optional/nullish descriptive fields and optional EIP-3009 signatures. Follow compatible schemas without weakening the authorization relationships that determine spend. |
| The payment rails have no budget support. | Published core 2.25.0 already has client `spendControls`, including a default per-payment cap. Taximeter's distinct contribution is the persistent local ledger, attribution, rolling budgets, and exports. |

The HTTPS limitation follows from the transport design: a CONNECT tunnel gives
the proxy an encrypted stream, while the payment protocol lives inside HTTP
headers. Taximeter does not install a certificate authority or intercept TLS.
The package README documents which connection modes are metered.

For SDK composition, the intended pattern is
`wrapFetchWithPayment(withMeter(fetch, options), client)`. The official fetch
implementation invokes the supplied transport again for the replay, so this
placement allows the meter to observe the challenge and gate the authorization
before it reaches the upstream.
[@x402/fetch source](https://unpkg.com/@x402/fetch@2.25.0/dist/esm/index.mjs)

## Fixture provenance and verification limits

Fixture field names, example Base Sepolia token address, and envelope layout
come from the linked v1/v2 and exact EVM specification examples. Test values,
nonces, signatures, resource URLs, and transaction identifiers may be adapted
deterministically for localhost tests. They are **synthetic protocol examples**,
not captures of real paid requests and not evidence of cryptographic validity.
The fixture server accepts the documented replay shape without moving money.

Parser tests establish structural compatibility and exact accounting;
integration tests establish forwarding, blocking, idempotency, and failure
handling. Neither test category establishes on-chain settlement, facilitator
availability, wallet compatibility, or universal x402 support. Those claims are
outside the initial implementation and its non-custodial scope.
