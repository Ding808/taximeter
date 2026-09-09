import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme as ClientScheme } from "@x402/evm/exact/client";
import { ExactEvmScheme as ServerScheme } from "@x402/evm/exact/server";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { decodePaymentResponseHeader, wrapFetchWithPayment, x402Client } from "@x402/fetch";
import express from "express";
import { parseEventLogs } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import {
  AMOUNT,
  ASSET,
  addressSchema,
  balances,
  CHAIN_ID,
  CheckFailure,
  checkFunding,
  displayAmount,
  ensure,
  FACILITATOR,
  NETWORK,
  printFunding,
  ROOT,
  RPC,
  tokenAbi,
} from "./balance.mjs";
import { canonicalReceipt, requireCanonicalLog } from "./proof.mjs";

// Local verification harness only. Secrets are loaded by the client at runtime;
// no private key, signed header, or raw authorization is written to console/evidence.
const CLI = fileURLToPath(new URL("../../dist/cli/index.js", import.meta.url));
const argvSchema = z.union([z.tuple([]), z.tuple([z.literal("--check-only")])]);
const hashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const settlementSchema = z.object({
  success: z.literal(true),
  network: z.literal(NETWORK),
  transaction: hashSchema,
  payer: addressSchema.optional(),
  amount: z.string().optional(),
});
const requirementSchema = z.object({
  x402Version: z.literal(2),
  accepts: z
    .array(
      z.object({
        scheme: z.literal("exact"),
        network: z.literal(NETWORK),
        asset: addressSchema,
        amount: z.literal(AMOUNT.toString()),
        payTo: addressSchema,
        extra: z.object({
          name: z.literal("USDC"),
          version: z.literal("2"),
          assetTransferMethod: z.literal("eip3009").optional(),
        }),
      }),
    )
    .length(1),
});
const blockedSchema = z.strictObject({
  error: z.literal("blocked_by_taximeter"),
  reason: z.literal("global_budget"),
  budget: z.literal("1000"),
  spent: z.literal("1000"),
  remaining: z.literal("0"),
});
const totalSchema = z.object({
  network: z.literal(NETWORK),
  asset: z.string(),
  amount: z.literal("1000"),
  confirmedAmount: z.literal("1000"),
  unknownAmount: z.literal("0"),
  decimals: z.literal(6),
  decimalsKnown: z.literal(true),
});
const summarySchema = z.object({
  version: z.string(),
  totalEvents: z.literal(2),
  blockedEvents: z.literal(1),
  unknownEvents: z.literal(0),
  totals: z.array(totalSchema).length(1),
  diagnostics: z.array(z.unknown()).length(0),
  budgets: z
    .array(
      z.object({
        network: z.literal(NETWORK),
        asset: z.string(),
        limit: z.literal("1000"),
        spent: z.literal("1000"),
        remaining: z.literal("0"),
      }),
    )
    .length(1),
});

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}
function closeServer(server) {
  return new Promise((resolveClose, reject) => {
    server.closeAllConnections();
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
}
function startCli(directory, configPath, database, upstream) {
  const home = join(directory, "home");
  mkdirSync(home, { mode: 0o700 });
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  for (const name of Object.keys(env)) if (name.startsWith("TAXIMETER_")) delete env[name];
  // IPC enables the CLI's own SIGTERM cleanup on Windows without closing other processes.
  const hook =
    "process.on('message',m=>{if(m==='taximeter-test-shutdown'){process.emit('SIGTERM');process.disconnect();}});";
  const child = spawn(
    process.execPath,
    [
      "--import",
      `data:text/javascript,${encodeURIComponent(hook)}`,
      CLI,
      "start",
      "--config",
      configPath,
      "--db",
      database,
      "--proxy-port",
      "0",
      "--dashboard-port",
      "0",
      "--upstream",
      upstream,
    ],
    { cwd: directory, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  let stdout = "";
  let stderr = "";
  let exited = false;
  const exit = new Promise((resolveExit) =>
    child.once("exit", (code, signal) => {
      exited = true;
      resolveExit({ code, signal });
    }),
  );
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-32768);
  });
  const ready = new Promise((resolveReady, reject) => {
    const timeout = setTimeout(
      () => reject(new CheckFailure("Taximeter CLI did not become ready within 30 seconds.")),
      30000,
    );
    child.once("error", () => {
      clearTimeout(timeout);
      reject(new CheckFailure("Taximeter CLI could not start."));
    });
    child.once("exit", () => {
      clearTimeout(timeout);
      reject(new CheckFailure("Taximeter CLI exited before readiness."));
    });
    child.stdout.on("data", (chunk) => {
      stdout = (stdout + chunk.toString()).slice(-32768);
      const proxy = /Proxy: http:\/\/127\.0\.0\.1:(\d+)/.exec(stdout);
      const dashboard = /Dashboard: http:\/\/127\.0\.0\.1:(\d+)/.exec(stdout);
      const version = /Taximeter ([0-9]+\.[0-9]+\.[0-9]+)/.exec(stdout);
      if (proxy && dashboard && version) {
        const port = z.coerce.number().int().positive().max(65535);
        clearTimeout(timeout);
        resolveReady({
          proxyPort: port.parse(proxy[1]),
          dashboardPort: port.parse(dashboard[1]),
          version: version[1],
        });
      }
    });
  });
  return {
    ready,
    stderrClean: () => stderr.trim() === "",
    async stop() {
      if (!exited && child.connected) child.send("taximeter-test-shutdown");
      let timeout;
      const graceful = await Promise.race([
        exit,
        new Promise((resolveTimeout) => {
          timeout = setTimeout(() => resolveTimeout(null), 10000);
        }),
      ]);
      clearTimeout(timeout);
      if (graceful === null) {
        child.kill();
        await exit;
        throw new CheckFailure(
          "Taximeter CLI needed forced termination; live verification did not pass.",
        );
      }
      ensure(
        graceful.code === 0 && graceful.signal === null,
        "Taximeter CLI did not exit cleanly.",
      );
    },
  };
}

async function live() {
  let stage = "funding";
  let directory;
  let cli;
  let server;
  let failure;
  let evidence;
  let txHash;
  const counts = {
    transportUnsigned: 0,
    transportSigned: 0,
    challenges: 0,
    serverSigned: 0,
    verify: 0,
    settle: 0,
    settled: 0,
    handler: 0,
    sdkErrors: 0,
  };
  const oldError = console.error;
  const oldWarn = console.warn;
  // SDK exceptions can contain signed payloads. Suppress their detail while retaining a failure count.
  console.error = () => {
    counts.sdkErrors += 1;
  };
  console.warn = () => {
    counts.sdkErrors += 1;
  };
  const started = performance.now();
  try {
    const { Ledger, totals } = await import(new URL("../../dist/index.js", import.meta.url).href);
    console.log("Taximeter live verification | Base Sepolia | TESTNET ONLY");
    const funding = await checkFunding();
    ensure(funding.funded, "Faucet funding is not available; no payment attempted.");
    const { wallets, client: chain, balance: before } = funding;
    console.log(`Funding verified: ${displayAmount(before.payer)} test USDC; chain ${CHAIN_ID}.`);
    directory = mkdtempSync(join(ROOT, "live-run-"));
    const database = join(directory, "ledger.db");
    stage = "facilitator";
    const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR });
    const supported = z
      .object({
        kinds: z.array(
          z.object({ x402Version: z.number(), scheme: z.string(), network: z.string() }),
        ),
      })
      .parse(await facilitator.getSupported());
    ensure(
      supported.kinds.some(
        (kind) => kind.x402Version === 2 && kind.scheme === "exact" && kind.network === NETWORK,
      ),
      "Public facilitator does not advertise the required testnet scheme.",
    );
    const resourceServer = new x402ResourceServer(facilitator).register(
      NETWORK,
      new ServerScheme(),
    );
    resourceServer.onBeforeVerify(async () => {
      counts.verify += 1;
    });
    resourceServer.onBeforeSettle(async () => {
      counts.settle += 1;
    });
    resourceServer.onAfterSettle(async () => {
      counts.settled += 1;
    });
    const app = express();
    app.disable("x-powered-by");
    app.use((req, _res, next) => {
      if (req.headers["payment-signature"]) counts.serverSigned += 1;
      next();
    });
    app.use(
      paymentMiddleware(
        {
          "GET /weather": {
            accepts: [
              {
                scheme: "exact",
                network: NETWORK,
                payTo: wallets.recipient,
                price: {
                  amount: AMOUNT.toString(),
                  asset: ASSET,
                  extra: { name: "USDC", version: "2" },
                },
                maxTimeoutSeconds: 60,
              },
            ],
            description: "Live Base Sepolia testnet weather request",
            mimeType: "application/json",
          },
        },
        resourceServer,
      ),
    );
    app.get("/weather", (_req, res) => {
      counts.handler += 1;
      res.json({ weather: "sunny", testnetOnly: true });
    });
    app.use((_error, _req, res, _next) => {
      counts.sdkErrors += 1;
      res.status(500).json({ error: "test_server_error" });
    });
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolveListen, reject) => {
      server.once("listening", resolveListen);
      server.once("error", () =>
        reject(new CheckFailure("Local Express server could not listen.")),
      );
    });
    const upstreamPort = z
      .object({ port: z.number().int().positive() })
      .parse(server.address()).port;
    const upstream = `http://127.0.0.1:${upstreamPort}`;
    const budget = { amount: "1000000", asset: "USDC", network: NETWORK, window: "24h" };
    const configPath = join(directory, "taximeter.config.json");
    writeJson(configPath, {
      db: database,
      upstream,
      ports: { proxy: 0, dashboard: 0 },
      budgets: {
        perTask: budget,
        perAgent: budget,
        global: { ...budget, amount: AMOUNT.toString() },
      },
      policy: {
        allowHosts: ["127.0.0.1"],
        allowPayTo: [wallets.recipient],
        maxSinglePayment: AMOUNT.toString(),
        unknownAsset: "deny",
      },
    });
    stage = "cli-start";
    cli = startCli(directory, configPath, database, upstream);
    const running = await cli.ready;
    const proxyUrl = `http://127.0.0.1:${running.proxyPort}/weather`;
    console.log(
      `Taximeter ${running.version}: actual CLI proxy ready; global budget 0.001000 test USDC.`,
    );
    console.log("Official Express + x402 client; settlement uses the public HTTPS facilitator.");
    stage = "client-setup";
    // This is the only secret-file read. The key is never interpolated into output or evidence.
    const signer = privateKeyToAccount(
      z
        .string()
        .regex(/^0x[0-9a-fA-F]{64}$/)
        .parse(readFileSync(join(ROOT, "secrets", "payer.key"), "utf8").trim()),
    );
    ensure(
      signer.address.toLowerCase() === wallets.payer.toLowerCase(),
      "Protected payer key does not match the public test wallet.",
    );
    const paymentClient = new x402Client().register(NETWORK, new ClientScheme(signer));
    const transport = async (input, init) => {
      const request = new Request(input, init);
      ensure(request.url === proxyUrl, "Payment transport attempted an unexpected destination.");
      if (request.headers.has("payment-signature")) counts.transportSigned += 1;
      else counts.transportUnsigned += 1;
      const response = await fetch(request, {
        redirect: "error",
        signal: AbortSignal.timeout(120000),
      });
      if (response.status === 402 && response.headers.has("payment-required")) {
        const challenge = requirementSchema.parse(
          JSON.parse(
            Buffer.from(response.headers.get("payment-required"), "base64").toString("utf8"),
          ),
        );
        ensure(
          challenge.accepts[0].asset.toLowerCase() === ASSET.toLowerCase() &&
            challenge.accepts[0].payTo.toLowerCase() === wallets.recipient.toLowerCase(),
          "Payment challenge changed token or recipient.",
        );
        counts.challenges += 1;
        if (counts.challenges === 1)
          console.log("HTTP 402 observed: official challenge requests exactly 0.001000 test USDC.");
      }
      return response;
    };
    const paidFetch = wrapFetchWithPayment(transport, paymentClient);
    const options = {
      headers: { "taximeter-task": "live-testnet", "taximeter-agent": "official-x402-client" },
    };
    stage = "first-payment";
    // Exactly one call. Do not retry this operation after an uncertain result.
    const first = await paidFetch(proxyUrl, options);
    ensure(
      first.status === 200,
      "First paid request did not return HTTP 200; no automatic retry will run.",
    );
    z.object({ weather: z.literal("sunny"), testnetOnly: z.literal(true) }).parse(
      await first.json(),
    );
    const header = first.headers.get("payment-response");
    ensure(header !== null, "Successful response did not include a settlement receipt.");
    const settlement = settlementSchema.parse(decodePaymentResponseHeader(header));
    ensure(
      !settlement.payer || settlement.payer.toLowerCase() === wallets.payer.toLowerCase(),
      "Settlement payer mismatch.",
    );
    ensure(
      !settlement.amount || settlement.amount === AMOUNT.toString(),
      "Settlement amount mismatch.",
    );
    txHash = settlement.transaction;
    console.log("Signed replay passed the proxy; HTTP 200 returned with settlement evidence.");
    console.log(`Transaction: ${txHash}`);
    stage = "receipt";
    ensure(
      (await chain.getChainId()) === CHAIN_ID,
      "RPC network changed; stopped before further payment activity.",
    );
    const proof = await canonicalReceipt(chain, txHash);
    const { receipt } = proof;
    ensure(
      receipt.status === "success" &&
        receipt.transactionHash.toLowerCase() === txHash.toLowerCase(),
      "Testnet receipt was not successful.",
    );
    const transfers = parseEventLogs({
      abi: tokenAbi,
      eventName: "Transfer",
      logs: receipt.logs,
      strict: true,
    });
    const matches = transfers.filter(
      (log) =>
        log.address.toLowerCase() === ASSET.toLowerCase() &&
        log.args.from.toLowerCase() === wallets.payer.toLowerCase() &&
        log.args.to.toLowerCase() === wallets.recipient.toLowerCase() &&
        log.args.value === AMOUNT,
    );
    ensure(
      matches.length === 1,
      "Receipt did not contain exactly one matching canonical USDC Transfer.",
    );
    requireCanonicalLog(receipt, matches[0]);
    const after = await balances(chain, wallets);
    ensure(
      before.payer - after.payer === AMOUNT && after.recipient - before.recipient === AMOUNT,
      "Test USDC balances did not change by exactly 1000 atomic units.",
    );
    console.log(
      "Chain proof: canonical receipt/block match, 2 confirmations, matching USDC Transfer log.",
    );
    console.log(
      `Balances: payer -0.001000; recipient +0.001000 test USDC (${displayAmount(after.recipient)} total).`,
    );
    ensure(
      counts.verify === 1 &&
        counts.settle === 1 &&
        counts.settled === 1 &&
        counts.serverSigned === 1 &&
        counts.handler === 1,
      "First request did not produce exactly one server verification and settlement.",
    );
    stage = "budget-block";
    const second = await paidFetch(proxyUrl, options);
    ensure(second.status === 402, "Second payment was not blocked by the proxy.");
    const blocked = blockedSchema.parse(await second.json());
    ensure(
      !second.headers.has("payment-response"),
      "Blocked request unexpectedly had settlement evidence.",
    );
    ensure(
      counts.transportUnsigned === 2 && counts.transportSigned === 2 && counts.challenges === 2,
      "Client request/replay counts were not exactly two payment attempts.",
    );
    ensure(
      counts.verify === 1 &&
        counts.settle === 1 &&
        counts.settled === 1 &&
        counts.serverSigned === 1 &&
        counts.handler === 1,
      "Blocked payment reached the seller or facilitator.",
    );
    const finalBalance = await balances(chain, wallets);
    ensure(
      finalBalance.payer === after.payer && finalBalance.recipient === after.recipient,
      "Balances changed after the blocked request.",
    );
    console.log("Second signed request: BLOCKED at proxy — budget 1000, spent 1000, remaining 0.");
    console.log(
      "Seller verification/settlement counts remain 1; blocked request caused no transfer.",
    );
    stage = "ledger";
    const ledger = new Ledger(database);
    let total;
    try {
      const events = ledger.view();
      ensure(
        events.length === 2 &&
          events.filter((event) => event.status === "observed").length === 1 &&
          events.filter((event) => event.status === "blocked").length === 1,
        "Ledger event counts did not match the live requests.",
      );
      const observed = events.find((event) => event.status === "observed");
      ensure(
        observed.settlementStatus === "confirmed" &&
          observed.txHash.toLowerCase() === txHash.toLowerCase(),
        "Ledger did not retain matching confirmed settlement.",
      );
      total = z.array(totalSchema).length(1).parse(totals(events))[0];
      ensure(total.asset.toLowerCase() === ASSET.toLowerCase(), "Ledger token mismatch.");
      ensure(
        ledger.diagnostics().length === 0,
        "Ledger diagnostics were emitted during the live run.",
      );
    } finally {
      ledger.close();
    }
    const dashboard = await fetch(`http://127.0.0.1:${running.dashboardPort}/api/summary`, {
      signal: AbortSignal.timeout(10000),
    });
    ensure(dashboard.ok, "Dashboard summary request failed.");
    const summary = summarySchema.parse(await dashboard.json());
    ensure(
      summary.totals[0].asset.toLowerCase() === ASSET.toLowerCase() &&
        summary.budgets[0].asset.toLowerCase() === ASSET.toLowerCase(),
      "Dashboard token mismatch.",
    );
    ensure(
      cli.stderrClean() && counts.sdkErrors === 0,
      "CLI or official SDK emitted unexpected errors or warnings.",
    );
    console.log(
      "Ledger and dashboard agree: 1000 confirmed atomic units, 1 blocked event, 0 diagnostics.",
    );
    evidence = {
      result: "passed",
      testnetOnly: true,
      timestamp: new Date().toISOString(),
      network: NETWORK,
      chainId: CHAIN_ID,
      asset: ASSET,
      amountAtomic: AMOUNT.toString(),
      payer: wallets.payer,
      recipient: wallets.recipient,
      packageVersions: {
        taximeter: running.version,
        x402: "2.25.0",
        viem: "2.56.3",
        express: "5.2.1",
      },
      transport: {
        mode: "actual CLI explicit upstream proxy",
        upstream: "local HTTP Express",
        facilitator: FACILITATOR,
        rpc: RPC,
        proxyPort: running.proxyPort,
        dashboardPort: running.dashboardPort,
      },
      receipt: {
        hash: txHash,
        blockHash: receipt.blockHash,
        blockNumber: receipt.blockNumber.toString(),
        status: receipt.status,
        confirmations: 2,
        initialReportedBlockHash: proof.initialReportedBlockHash,
        canonicalBlockHash: proof.canonicalBlockHash,
        observedChainHeight: proof.observedChainHeight.toString(),
        receiptReadAttempts: proof.receiptReadAttempts,
        matchingTransferLogs: matches.length,
        explorer: `https://sepolia.basescan.org/tx/${txHash}`,
      },
      balances: {
        payerBefore: before.payer.toString(),
        payerAfter: after.payer.toString(),
        recipientBefore: before.recipient.toString(),
        recipientAfter: after.recipient.toString(),
      },
      counts,
      blocked,
      ledger: {
        confirmedAmount: total.confirmedAmount,
        unknownAmount: total.unknownAmount,
        observedEvents: 1,
        blockedEvents: 1,
        diagnostics: 0,
      },
      elapsedMs: Math.round(performance.now() - started),
      database,
      scope:
        "Real testnet transfer and L2 inclusion; no mainnet funds and no claim of Ethereum finality. Raw authorizations are retained only in the local ledger, excluded from this evidence.",
    };
  } catch (error) {
    failure =
      error instanceof CheckFailure
        ? error.message
        : `Verification failed during ${stage}; sensitive error details suppressed.`;
  } finally {
    if (cli) {
      try {
        await cli.stop();
      } catch {
        failure ??= "CLI cleanup failed.";
      }
    }
    if (server) {
      try {
        await closeServer(server);
      } catch {
        failure ??= "Express cleanup failed.";
      }
    }
    console.error = oldError;
    console.warn = oldWarn;
  }
  if (directory) {
    const evidencePath = join(directory, "evidence.json");
    writeJson(
      evidencePath,
      failure
        ? {
            result: "failed",
            testnetOnly: true,
            stage,
            reason: failure,
            counts,
            ...(txHash ? { transactionHash: txHash } : {}),
            directory,
          }
        : { ...evidence, cleanup: "CLI and Express closed successfully" },
    );
    console.log(`Evidence: ${evidencePath}`);
  }
  if (failure) {
    console.log(failure);
    console.log("TESTNET E2E FAILED");
    process.exitCode = 1;
  } else {
    console.log("TESTNET E2E PASSED");
  }
}

try {
  const args = argvSchema.parse(process.argv.slice(2));
  if (args[0] === "--check-only") await printFunding();
  else await live();
} catch (error) {
  console.error(
    error instanceof CheckFailure
      ? error.message
      : "Testnet harness failed; sensitive error details suppressed.",
  );
  console.log("TESTNET E2E FAILED");
  process.exitCode = 1;
}
