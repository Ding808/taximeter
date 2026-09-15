# Payment protocol and accounting

Taximeter meters HTTP x402 v1/v2 `exact` payments using EVM EIP-3009
authorizations. It records and gates payments; the client signs and the upstream
facilitator settles them. Taximeter never holds a private key or makes runtime
RPC, metadata, or exchange-rate requests.

## Supported traffic

| Transport | Payment visibility |
| --- | --- |
| HTTP forward proxy | Supported payment headers and responses are visible. |
| Explicit upstream | HTTP messages sent to the configured HTTP(S) origin are visible. |
| Fetch SDK | Requests made through the wrapped transport are visible. |
| HTTPS CONNECT | Encrypted tunnel traffic passes through unmetered. |
| HTTP upgrade | Supported signed handshakes can be gated; upgraded frames are unmetered. |

Permit2, ERC-7710, non-EVM transfer methods, Stripe MPP, and other x402 schemes
are unsupported. Unrecognized or malformed payment traffic passes through with a
diagnostic. A status of HTTP 402 alone does not identify a payment protocol.

### Headers and challenge correlation

Version 1 reads the initial JSON challenge, `X-PAYMENT` on replay, and
`X-PAYMENT-RESPONSE` on settlement. Its legacy `base` and `base-sepolia` networks
map to `eip155:8453` and `eip155:84532`. Other v1 network names are not mapped.

The v1 replay does not supply asset context. Taximeter must have observed an
unambiguous matching challenge for the URL, method, task, agent, Authorization,
and Cookie. Context expires after five minutes and is capped at 1,000 entries
per intake instance. Ambiguous or missing context is diagnosed, not guessed.

Version 2 uses `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, and `PAYMENT-RESPONSE`.
The replay includes its selected `accepted` requirements and an EVM CAIP-2
network, so it need not be preceded by an observed challenge.

Payment headers are limited to 65,536 characters and observed challenge bodies
to 64 KiB. The SDK also limits challenge-body observation to 100 ms. Slow,
oversized, compressed proxy challenges and redirected SDK challenges can prevent
correlation. The upstream's ordinary traffic still passes through.

## Asset identity and budgets

All amounts are atomic integer strings and calculations use `BigInt`. A balance
belongs to one normalized network and contract; there is no combined dollar total.
The offline registry recognizes six-decimal USDC at these addresses:

| Network | Contract |
| --- | --- |
| Base (`eip155:8453`) | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| Base Sepolia (`eip155:84532`) | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |

Parsed unknown assets are denied by default. Opting in with
`policy.unknownAsset: "allow"` requires matching contract budgets to cap them;
default USDC budgets do not apply. Unknown decimals are displayed as atomic units.
Wire-provided symbols and decimals cannot make an asset trusted.

Amount and payment-count budgets share task, agent, global, asset, network, and
window rules. Each scope checks amount first, then count. A counted zero-value
payment still consumes one payment; blocked and known-failed payments consume
neither. See the [configuration reference](../README.md#configuration).

## Reservations, retries, and settlement

A challenge is an offer. A recognized replay reserves capacity in the same
SQLite transaction that evaluates policy, before forwarding to the upstream.
This prevents concurrent requests from using the same remaining budget.

An authorization's identity binds network, asset, payer, nonce, amount,
recipient, and validity bounds. Repeated observations count once across retries
and resources; conflicting immutable fields receive separate reservations.
Signature bytes and transaction hashes are not the deduplication key.

Each forwarding attempt has an append-only outcome. Any reported confirmation
wins; otherwise an unresolved attempt keeps capacity reserved. Only a payment
whose attempts all failed releases its contribution. An unconfirmed retry outside
a rolling window must reacquire capacity in the current window.

Settlement evidence uses the wire field `transaction`, mapped internally to
`txHash`. Headers are inspected on every response status and must agree with the
payment's network and any supplied payer/amount. Missing or inconsistent evidence,
disconnects, and unconfirmed upstream errors remain unknown. A settlement report
is not independent chain verification.

The immutable log is the source of truth. The schema-3 prefix cache maintains
exact amount and count projections incrementally and can be rebuilt. Exports
and the dashboard derive the same contributions. CSV `amount` is counted spend;
`authorizedAmount` retains the original proposal, including blocked attempts.

## Operational boundaries

Storage failures preserve traffic and print a warning, so enforcement requires
working storage. The meter is not a security boundary against a bypassing client.
Host policy checks the actual upstream URL; redirects and retries hidden inside
an SDK-supplied transport cannot be checked individually. Use `redirect: "error"`
when each destination must be checked. Raw authorizations remain in the local
ledger and JSON exports; see [security guidance](../SECURITY.md).

The recorded [Base Sepolia example](../examples/live-testnet/README.md) verifies
one real payment through a local HTTP seller. It does not establish mainnet,
HTTPS-upstream, or SDK payment coverage. [Test methods](TESTING.md) distinguish
that evidence from synthetic fixtures.

## Protocol references

- [x402 v1 specification](https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v1.md)
- [x402 v2 specification](https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md)
- [Network and token support](https://docs.x402.org/core-concepts/network-and-token-support)
