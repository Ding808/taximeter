# x402 fixture provenance

The fixture reproduces the HTTP v1/v2 envelopes from the primary sources linked
in SPEC-NOTES.md. Authorizations, nonces, signatures, and settlement responses are
synthetic. No wallet, private key, facilitator, RPC call, or transfer is involved.
Structural acceptance by this fixture does not prove a signature is valid.

`/v1` returns JSON requirements and accepts `X-PAYMENT`. `/v2` returns
`PAYMENT-REQUIRED` and accepts `PAYMENT-SIGNATURE`. Query parameters select response
status, delay, and settlement evidence for failure tests. Other routes exercise
opaque gzip bytes, oversized 402 bodies, request echoing, trailers, and disconnects.
