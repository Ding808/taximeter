# Protocol verification notes

Research date: **2026-09-08**. These notes record the protocol baseline read before
implementation, the supported subset, and corrections to [SPEC.md](SPEC.md).
Amounts below are atomic integer strings. Taximeter does not sign, verify, or
settle a payment.

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
   Correlation uses the actual upstream resource and request context, with a
   bounded lifetime, then matches scheme, network, recipient, and atomic amount.
   Ambiguous asset choices must not be guessed. A v2 replay can supply its own
   selected requirements, so the initial 402 exchange need not have been seen.
   Host policy uses the actual upstream URL, not an untrusted advertised URL.
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
   Derivations exclude a known failed payment unless contradictory success
   evidence exists. Missing settlement evidence, a disconnect, or an upstream
   5xx after forwarding does not silently release that capacity.
8. **Idempotency.** The principal EIP-3009 identity includes network, asset,
   payer, and nonce. Repeated observations of that authorization count once,
   including observations under a different resource. Nonce alone would collide
   across payers/contracts; transaction hash alone can collapse different
   transfers in one transaction. Resource and wall-clock time alone are not a
   reliable payment identity. The optional protocol payment-identifier extension
   is preserved but is not trusted to override an EIP-3009 authorization identity.
9. **Concurrency.** Policy evaluation and reservation must be one synchronous
   operation before forwarding. Otherwise concurrent requests can all observe
   the same old total. Totals derive from the event log; settlement observations
   do not mutate earlier rows.
10. **Transparency boundary.** Unsupported or malformed traffic is forwarded
    unchanged with `parse_failed` diagnostics. Therefore this is a cooperative
    local meter, not a security boundary against an agent deliberately bypassing
    the proxy or using an unsupported payment form. Raw audit payloads are
    payment authorizations, not private keys; the ledger is local state.

## Corrections and limits relative to the brief

| Brief assumption or omission | Resolution |
| --- | --- |
| Coinbase repository is the primary project home. | Read the requested files and follow the README's Foundation pointer; preserve source links and research date above. |
| x402 can be treated as a single generic 402 JSON shape. | Implement the two header generations and their distinct envelopes. A generic 402 is not necessarily a payment. |
| Every replay contains enough information to construct a payment event. | v1 omits the asset and resource and needs unambiguous challenge correlation. v2 includes `accepted` and can arrive without an initial observed 402. |
| A fixed exact EVM signature shape covers all x402. | The live scheme includes Permit2 and ERC-7710; published EVM types include multiple methods and variable signature forms. Initial support is explicitly EIP-3009. |
| `decimals` and `assetSymbol` can be parsed from every payment. | These are local metadata. Unknown tokens are shown in atomic units; arbitrary `extra.name` is not trusted. |
| USDC symbol budgets define one aggregate global balance. | Budgets remain separate by network and contract, including trusted USDC deployments. |
| An unscoped maximum atomic amount means one USDC for every asset. | `maxSingleAsset` defines its asset scope; the default is known USDC. |
| An observed signed payment is necessarily paid spend. | Track authorization plus append-only settlement outcomes; label upstream-reported confirmation accurately. |
| `PaymentEvent` only needs the listed fields. | Add internal identity, decimals-known metadata, and settlement outcome information so deduplication and uncertainty are explicit. These are Taximeter fields, not invented x402 fields. |
| Nonce, transaction hash, or resource plus timestamp are interchangeable deduplication keys. | Use the EIP-3009 authorization identity and retain outcome correlation; do not drop independent transfers that share a transaction. |
| Proxy budget checks can wait until the response arrives. | Reserve synchronously before forwarding to prevent concurrent overspend. |
| `HTTP_PROXY` / `HTTPS_PROXY` guarantees zero-code metering for every client. | Environment-variable support depends on the client. HTTPS CONNECT carries encrypted bytes; without intercepting TLS, its payment headers are invisible. Transparent CONNECT is unmetered and identified as such. Use the explicit localhost route or SDK for metered HTTPS upstream access. |
| Wrapping any payment-enabled fetch necessarily gates its internal retries. | Supply `withMeter(fetch, options)` as the transport to `wrapFetchWithPayment`. Wrapping the outer payment wrapper cannot observe its internal signed replay. |
| Loading Google Fonts is compatible with zero additional runtime network calls. | Use local fonts or complete system fallback stacks. The dashboard must not fetch fonts from Google at runtime. |
| The payment rails have no budget support. | Published core 2.25.0 already has client `spendControls`, including a default per-payment cap. Taximeter's distinct contribution is the persistent local ledger, attribution, rolling budgets, and exports. |
| Real protocol fixtures require real payments. | Fixtures reproduce documented wire envelopes using deterministic synthetic authorizations and settlement results. No genuine transfers or facilitator calls are performed. |

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
