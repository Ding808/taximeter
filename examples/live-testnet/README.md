# Live Base Sepolia example

This optional development example runs a real **testnet** x402 payment through the
Taximeter CLI. It uses the official Express server and fetch client SDKs, Circle's
Base Sepolia test USDC, and the public `https://x402.org/facilitator` service.
Testnet tokens have no financial value. Never fund these disposable wallets on
mainnet or reuse their keys for anything valuable.

The example is a separate private package. Its SDK dependencies, keys, and live
requests are not part of Taximeter's runtime package or default test suite.

## Prepare

Use Node 20 or newer. From the repository root:

```sh
npm ci
npm run build
cd examples/live-testnet
npm ci
npm run prepare-wallet
```

Wallet preparation creates `secrets/payer.key`, `secrets/recipient.key`, and a
public `wallet-addresses.json`. It prints public addresses only and preserves
existing keys on subsequent runs. These local files are ignored by Git. File
creation requests private permissions; Windows uses the directory's inherited
access controls. The payer key is loaded only by this example's signing client.
Taximeter receives a signed authorization and never receives the private key.

Open [Circle's public faucet](https://faucet.circle.com/), select **USDC** and
**Base Sepolia**, and enter the printed payer address. The faucet currently offers
20 test USDC every two hours per address/network without an account. Complete any
human verification shown by the faucet, then run:

```sh
npm run check
```

This command uses public addresses and read-only RPC calls. It does not read keys,
start a payment server, or submit a payment; it also works without the Taximeter
build. The payer must have at least `1000` atomic units (`0.001000` test USDC).

## Run once

```sh
npm start
```

The harness creates a fresh ignored `live-run-*` directory and starts the actual
built CLI with an explicit upstream, an isolated database, and available local
ports. The protected Express server runs over local HTTP; its facilitator calls
and the chain verification use public HTTPS services. This does not test payment
visibility inside an encrypted CONNECT tunnel.

The run verifies:

1. Base Sepolia chain ID `84532`, canonical USDC contract
   `0x036CbD53842c5426634e7929541eC2318f3dCF7e`, six decimals, and signing domain
   `USDC` version `2`.
2. An actual HTTP 402 challenge and a signed EIP-3009 replay through Taximeter.
3. One `1000`-unit payment, a successful receipt with a nonzero block hash matching
   the canonical block containing that transaction, and chain height at least one
   block beyond it. Early
   preconfirmation receipts are retained as such and checked again using reads
   only. A matching USDC Transfer log with consistent transaction/block metadata
   and exact payer/recipient balance changes
   are also required. This proves testnet L2 inclusion, not Ethereum finality.
4. A second fresh signed payment blocked by the `1000`-unit global budget before
   reaching the seller's verification or settlement hooks. The second request
   transfers no tokens.
5. Agreement between the local ledger and dashboard: `1000` confirmed units, one
   blocked event, and no diagnostics.

The facilitator submits the EIP-3009 transaction and pays test gas; this payment
path requires no payer ETH or token approval. Both local servers close before the
harness prints `TESTNET E2E PASSED` or `TESTNET E2E FAILED`.

Each invocation deliberately attempts one paid request and one budget-blocked
request. There is no automatic retry of a paid operation after uncertainty. If a
run fails after signing, inspect its transaction and retained ledger before
starting another run: a new invocation has a fresh budget and can make another
testnet payment. Public faucet, facilitator, and RPC availability can affect the
result.

`live-run-*/evidence.json` contains public, redacted verification results. Keys,
signed headers, and raw authorizations are never printed. The local SQLite ledger
retains raw authorizations for auditing; keep the entire run directory private
and share only reviewed, redacted evidence. No live artifacts are committed.

## Read-only proof tests

```sh
npm test
```

These tests use mocked RPC responses to check preconfirmation, canonical block,
confirmation-depth, revert, and timeout handling. They do not read wallets or
contact a network.

## Sources

- [Official x402 Express example](https://github.com/x402-foundation/x402/blob/main/examples/typescript/servers/express/index.ts)
- [Official x402 fetch example](https://github.com/x402-foundation/x402/blob/main/examples/typescript/clients/fetch/index.ts)
- [Exact scheme and EIP-3009 flow](https://docs.x402.org/schemes/exact)
- [Public facilitator capabilities](https://x402.org/facilitator/supported)
- [Circle USDC contracts and testnet token status](https://developers.circle.com/stablecoins/usdc-contract-addresses)
- [Viem receipt verification](https://viem.sh/docs/actions/public/waitForTransactionReceipt)
