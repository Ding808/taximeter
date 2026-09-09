import { createServer, request, type Server } from "node:http";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { parseConfig } from "../src/config";
import { totals } from "../src/ledger/derive";
import { Ledger } from "../src/ledger/store";
import { blockedBodySchema } from "../src/model";
import { closeProxy, createProxy } from "../src/proxy";
import { payloadV2Schema } from "../src/rails/schemas";
import { type MeteredFetch, withMeter } from "../src/sdk";
import { encode, listen, paymentHeader, requirements, stop } from "./fixtures/upstream";

const unknownAsset = "0x0000000000000000000000000000000000000001";
const opaque = Buffer.from([0, 255, 128, 13, 10, 42]);
type Reply = { status: number; body: Buffer };
type Mode = "proxy" | "sdk";

function unknownPayment(version: 1 | 2, resource: string): Record<string, string> {
  const headers = paymentHeader(version, 1, resource);
  if (version === 1) return headers;
  const encoded = z.string().parse(headers["payment-signature"]);
  const payload = payloadV2Schema.parse(JSON.parse(Buffer.from(encoded, "base64").toString()));
  return {
    "payment-signature": encode({
      ...payload,
      accepted: { ...payload.accepted, asset: unknownAsset },
    }),
  };
}

async function withTransport(
  mode: Mode,
  allow: boolean,
  run: (context: {
    send: (path: string, headers?: Record<string, string>) => Promise<Reply>;
    resource: (path: string) => string;
    ledger: Ledger;
    forwarded: () => number;
  }) => Promise<void>,
) {
  const config = parseConfig(allow ? { policy: { unknownAsset: "allow" } } : {});
  let forwarded = 0;
  const upstream = createServer((req, res) => {
    forwarded += 1;
    if (req.url === "/v1" && !req.headers["x-payment"]) {
      res.writeHead(402, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          x402Version: 1,
          accepts: [{ ...requirements(1, `http://${req.headers.host}/v1`), asset: unknownAsset }],
        }),
      );
    } else {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.end(opaque);
    }
  });
  const upstreamPort = await listen(upstream);
  const resource = (path: string) => `http://127.0.0.1:${upstreamPort}${path}`;
  const ledger = new Ledger(":memory:");
  let proxy: Server | undefined;
  let metered: MeteredFetch | undefined;
  try {
    let send: (path: string, headers?: Record<string, string>) => Promise<Reply>;
    if (mode === "sdk") {
      metered = withMeter(fetch, { ledger, config });
      const transport = metered;
      send = async (path, headers = {}) => {
        const response = await transport(resource(path), { headers });
        return { status: response.status, body: Buffer.from(await response.arrayBuffer()) };
      };
    } else {
      proxy = createProxy({ ledger, config });
      const port = await listen(proxy);
      send = (path, headers = {}) =>
        new Promise((resolve, reject) => {
          const outgoing = request(
            { hostname: "127.0.0.1", port, path: resource(path), headers, agent: false },
            (response) => {
              const chunks: Buffer[] = [];
              response.on("data", (chunk: unknown) =>
                chunks.push(z.instanceof(Buffer).parse(chunk)),
              );
              response.once("error", reject);
              response.once("end", () =>
                resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks) }),
              );
            },
          );
          outgoing.once("error", reject);
          outgoing.setTimeout(5000, () => outgoing.destroy(new Error("Proxy request timed out")));
          outgoing.end();
        });
    }
    await run({ send, resource, ledger, forwarded: () => forwarded });
  } finally {
    metered?.close();
    if (proxy) await closeProxy(proxy);
    await stop(upstream);
    ledger.close();
  }
}

describe.each<Mode>(["proxy", "sdk"])("unknown-asset policy through %s", (mode) => {
  test.each([1, 2] as const)(
    "default policy blocks a parsed v%i unknown token before forwarding its replay",
    async (version) => {
      await withTransport(mode, false, async ({ send, resource, ledger, forwarded }) => {
        const path = `/v${version}`;
        if (version === 1) expect((await send(path)).status).toBe(402);
        const before = forwarded();
        const response = await send(path, unknownPayment(version, resource(path)));
        expect(response.status).toBe(402);
        expect(blockedBodySchema.parse(JSON.parse(response.body.toString()))).toEqual({
          error: "blocked_by_taximeter",
          reason: "unknown_asset",
          budget: null,
          spent: "0",
          remaining: null,
          fix: "taximeter config set policy.unknownAsset allow",
        });
        expect(forwarded()).toBe(before);
        expect(ledger.view()).toHaveLength(1);
        expect(ledger.view()[0]).toMatchObject({
          status: "blocked",
          reason: "unknown_asset",
          asset: unknownAsset,
          decimalsKnown: false,
        });
        expect(totals(ledger.view())).toEqual([]);
      });
    },
  );

  test("explicit allow forwards and records a parsed custom-token payment", async () => {
    await withTransport(mode, true, async ({ send, resource, ledger, forwarded }) => {
      const response = await send("/v2", unknownPayment(2, resource("/v2")));
      expect(response).toEqual({ status: 200, body: opaque });
      expect(forwarded()).toBe(1);
      expect(ledger.view()[0]).toMatchObject({
        status: "observed",
        asset: unknownAsset,
        decimalsKnown: false,
      });
      expect(totals(ledger.view())[0]?.amount).toBe("7");
    });
  });

  test("unparseable payment traffic still reaches upstream byte-identically", async () => {
    await withTransport(mode, false, async ({ send, ledger, forwarded }) => {
      const response = await send("/opaque", { "payment-signature": "malformed" });
      expect(response).toEqual({ status: 200, body: opaque });
      expect(forwarded()).toBe(1);
      expect(ledger.events()).toEqual([]);
      expect(ledger.diagnostics()).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "parse_failed" })]),
      );
    });
  });
});
