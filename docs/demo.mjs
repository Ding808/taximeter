import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { closeProxy, createProxy, Ledger, parseConfig, totals } from "../dist/index.js";

// Synthetic envelopes only: no signing, wallet, facilitator, or real payment.
const asset = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const payTo = "0x209693bc6afc0c5328ba36faf03c514ef312287c";
const payer = "0x857b06519e91e3a54538791bdbb0e22373e36b66";
const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64");
const accepted = {
  scheme: "exact",
  network: "eip155:8453",
  asset,
  payTo,
  amount: "7",
  maxTimeoutSeconds: 60,
  extra: { name: "USD Coin", version: "2" },
};
const upstream = createServer((req, res) => {
  const header = z.string().optional().parse(req.headers["payment-signature"]);
  if (!header) {
    const resource = z
      .url()
      .parse(`http://${z.string().parse(req.headers.host)}${z.string().parse(req.url)}`);
    res.writeHead(402, {
      "PAYMENT-REQUIRED": encode({
        x402Version: 2,
        resource: { url: resource },
        accepts: [accepted],
      }),
    });
    res.end("Synthetic offer");
    return;
  }
  const payment = z
    .object({ payload: z.object({ authorization: z.object({ nonce: z.string() }) }) })
    .parse(JSON.parse(Buffer.from(header, "base64").toString("utf8")));
  res.writeHead(200, {
    "PAYMENT-RESPONSE": encode({
      success: true,
      network: "eip155:8453",
      payer,
      transaction: payment.payload.authorization.nonce,
    }),
  });
  res.end("Synthetic settlement reported");
});
async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return z.object({ port: z.number() }).parse(server.address()).port;
}
const ledger = new Ledger(":memory:");
const proxy = createProxy({
  ledger,
  config: parseConfig({ budgets: { perTask: null, perAgent: null, global: { amount: "140" } } }),
});
try {
  const upstreamPort = await listen(upstream);
  const proxyPort = await listen(proxy);
  const resource = `http://127.0.0.1:${upstreamPort}/data`;
  const offer = await fetch(resource);
  assert.equal(offer.status, 402);
  const challenge = z
    .object({
      x402Version: z.literal(2),
      resource: z.object({ url: z.url() }),
      accepts: z.array(z.object({ amount: z.literal("7") })),
    })
    .parse(
      JSON.parse(
        Buffer.from(z.string().parse(offer.headers.get("payment-required")), "base64").toString(
          "utf8",
        ),
      ),
    );
  assert.equal(challenge.resource.url, resource);
  await offer.arrayBuffer();
  console.log("Taximeter | local simulation | no money moves");
  console.log("Budget: 140 atomic units. Each payment: 7 atomic units.");
  for (let index = 1; index <= 21; index++) {
    const payload = {
      signature: `0x${"12".repeat(65)}`,
      authorization: {
        from: payer,
        to: payTo,
        value: "7",
        validAfter: "0",
        validBefore: "9999999999",
        nonce: `0x${index.toString(16).padStart(64, "0")}`,
      },
    };
    const result = await new Promise((resolve, reject) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          port: proxyPort,
          path: resource,
          headers: {
            "PAYMENT-SIGNATURE": encode({
              x402Version: 2,
              accepted,
              resource: { url: resource },
              payload,
            }),
            "Taximeter-Task": "demo",
            "Taximeter-Agent": "local-fixture",
          },
        },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            body += z.string().parse(chunk);
          });
          res.on("error", reject);
          res.on("end", () => resolve({ status: res.statusCode, body }));
        },
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(result.status, index <= 20 ? 200 : 402);
    console.log(
      `Payment ${index.toString().padStart(2)} | ${index <= 20 ? "allowed" : "BLOCKED"} | total ${totals(ledger.view())[0]?.amount} atomic units`,
    );
    if (index === 21) console.log(result.body);
    await delay(80);
  }
  assert.equal(totals(ledger.view())[0]?.amount, "140");
  assert.equal(ledger.events().filter((row) => row.status === "blocked").length, 1);
  console.log("Exact ledger total: 140 atomic units. One blocked event recorded.");
} finally {
  if (proxy.listening) await closeProxy(proxy);
  upstream.closeAllConnections();
  if (upstream.listening) await new Promise((resolve) => upstream.close(resolve));
  ledger.close();
}
