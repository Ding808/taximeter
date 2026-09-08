import { type IncomingHttpHeaders, request, type Server } from "node:http";
import { createServer as createTcpServer, type Socket } from "node:net";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { parseConfig } from "../src/config";
import { totals } from "../src/ledger/derive";
import { Ledger } from "../src/ledger/store";
import { blockedBodySchema } from "../src/model";
import { createProxy } from "../src/proxy/index";
import { fixtureUpstream, listen, opaqueBody, paymentHeader, stop } from "./fixtures/upstream";

type Reply = {
  status: number;
  headers: IncomingHttpHeaders;
  rawHeaders: string[];
  trailers: IncomingHttpHeaders;
  body: Buffer;
};

function throughProxy(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: Buffer[] } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: options.method ?? "GET",
        headers: options.headers,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: unknown) => chunks.push(z.instanceof(Buffer).parse(chunk)));
        res.once("error", reject);
        res.once("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            rawHeaders: res.rawHeaders,
            trailers: res.trailers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.setTimeout(10_000, () => req.destroy(new Error("Proxy test request timed out")));
    req.once("error", reject);
    for (const chunk of options.body ?? []) req.write(chunk);
    req.end();
  });
}

type Harness = {
  ledger: Ledger;
  proxy: Server;
  port: number;
  upstream: Awaited<ReturnType<typeof fixtureUpstream>>;
};

async function withProxy(
  run: (context: Harness) => Promise<void>,
  config: unknown = {},
  explicitUpstream = false,
): Promise<void> {
  const upstream = await fixtureUpstream();
  const ledger = new Ledger(":memory:");
  let proxy: Server | undefined;
  try {
    proxy = createProxy({
      ledger,
      config: parseConfig(
        { budgets: { perTask: null, perAgent: null, global: null } },
        config,
        explicitUpstream ? { upstream: upstream.url } : {},
      ),
    });
    const port = await listen(proxy);
    await run({ ledger, proxy, port, upstream });
  } finally {
    if (proxy?.listening) await stop(proxy);
    await upstream.close();
    ledger.close();
  }
}

const cap = (amount: string) => ({ budgets: { global: { amount, asset: "USDC" } } });

describe("native HTTP payment proxy", () => {
  test.each([1, 2] as const)(
    "100 simulated x402 v%i payments produce the exact integer total 700",
    async (version) => {
      await withProxy(async ({ ledger, port, upstream }) => {
        const resource = `${upstream.url}/v${version}`;
        const attribution = { "Taximeter-Task": "integration-100", "Taximeter-Agent": "agent-a" };
        const challenge = await throughProxy(port, resource, { headers: attribution });
        expect(challenge.status).toBe(402);
        for (let nonce = 1; nonce <= 100; nonce += 1) {
          const reply = await throughProxy(port, resource, {
            headers: { ...paymentHeader(version, nonce, resource), ...attribution },
          });
          expect(reply.status).toBe(200);
        }
        expect(upstream.paid()).toBe(100);
        expect(ledger.events()).toHaveLength(100);
        expect(ledger.view().every((event) => event.taskId === "integration-100")).toBe(true);
        expect(ledger.view().every((event) => event.agentId === "agent-a")).toBe(true);
        expect(totals(ledger.view())).toEqual([
          expect.objectContaining({ amount: "700", confirmedAmount: "700", unknownAmount: "0" }),
        ]);
      });
    },
  );

  test("payment 21 is rejected with all documented fields before it reaches upstream", async () => {
    await withProxy(async ({ ledger, port, upstream }) => {
      const resource = `${upstream.url}/v2`;
      for (let nonce = 1; nonce <= 20; nonce += 1) {
        expect(
          (await throughProxy(port, resource, { headers: paymentHeader(2, nonce, resource) }))
            .status,
        ).toBe(200);
      }
      const blocked = await throughProxy(port, resource, {
        headers: paymentHeader(2, 21, resource),
      });
      expect(blocked.status).toBe(402);
      const body = blockedBodySchema.parse(JSON.parse(blocked.body.toString("utf8")));
      expect(body).toEqual({
        error: "blocked_by_taximeter",
        reason: "global_budget",
        budget: "140",
        spent: "140",
        remaining: "0",
      });
      expect(upstream.paid()).toBe(20);
      expect(ledger.events().filter((event) => event.status === "blocked")).toEqual([
        expect.objectContaining({ amount: "7", reason: "global_budget" }),
      ]);
      expect(totals(ledger.view())).toEqual([expect.objectContaining({ amount: "140" })]);
    }, cap("140"));
  });

  test("100 concurrent unique payments cannot oversubscribe a 20-payment budget", async () => {
    await withProxy(async ({ ledger, port, upstream }) => {
      const resource = `${upstream.url}/v2?delay=25`;
      const replies = await Promise.all(
        Array.from({ length: 100 }, (_, index) =>
          throughProxy(port, resource, { headers: paymentHeader(2, index + 1, resource) }),
        ),
      );
      expect(replies.filter((reply) => reply.status === 200)).toHaveLength(20);
      expect(replies.filter((reply) => reply.status === 402)).toHaveLength(80);
      expect(upstream.paid()).toBe(20);
      expect(ledger.events().filter((event) => event.status === "blocked")).toHaveLength(80);
      expect(totals(ledger.view())).toEqual([expect.objectContaining({ amount: "140" })]);
      for (const reply of replies.filter((reply) => reply.status === 402)) {
        expect(blockedBodySchema.parse(JSON.parse(reply.body.toString("utf8")))).toMatchObject({
          error: "blocked_by_taximeter",
          remaining: "0",
        });
      }
    }, cap("140"));
  });

  test("concurrent duplicate retries at capacity forward while counting exactly once", async () => {
    await withProxy(async ({ ledger, port, upstream }) => {
      const resource = `${upstream.url}/v2?delay=25`;
      const headers = paymentHeader(2, 1, resource);
      const replies = await Promise.all(
        Array.from({ length: 10 }, () => throughProxy(port, resource, { headers })),
      );
      expect(replies.every((reply) => reply.status === 200)).toBe(true);
      expect(upstream.paid()).toBe(10);
      expect(ledger.events()).toHaveLength(1);
      expect(totals(ledger.view())).toEqual([expect.objectContaining({ amount: "7" })]);
      expect(ledger.events().some((event) => event.status === "blocked")).toBe(false);
    }, cap("7"));
  });

  test("reusing a nonce with a different authorized amount cannot bypass the budget", async () => {
    await withProxy(async ({ ledger, port, upstream }) => {
      const resource = `${upstream.url}/v2`;
      expect(
        (await throughProxy(port, resource, { headers: paymentHeader(2, 1, resource, "7") }))
          .status,
      ).toBe(200);
      const conflict = await throughProxy(port, resource, {
        headers: paymentHeader(2, 1, resource, "8"),
      });
      expect(conflict.status).toBe(402);
      expect(upstream.paid()).toBe(1);
      expect(ledger.events().filter((event) => event.status === "blocked")).toEqual([
        expect.objectContaining({ amount: "8", reason: "global_budget" }),
      ]);
      expect(totals(ledger.view())).toEqual([expect.objectContaining({ amount: "7" })]);
    }, cap("7"));
  });

  test("unknown compressed 402 traffic remains byte-identical with its original headers", async () => {
    await withProxy(async ({ ledger, port, upstream }) => {
      const reply = await throughProxy(port, `${upstream.url}/unknown`);
      expect(reply.status).toBe(402);
      expect(reply.body.equals(opaqueBody)).toBe(true);
      expect(reply.headers["content-encoding"]).toBe("gzip");
      expect(reply.headers["content-length"]).toBe(String(opaqueBody.length));
      expect(reply.headers["content-type"]).toBe("application/octet-stream");
      expect(reply.headers["set-cookie"]).toEqual(["a=1", "b=2"]);
      expect(ledger.events()).toEqual([]);
      expect(ledger.diagnostics()).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "parse_failed" })]),
      );
    });
  });

  test("an oversized unknown binary 402 passes intact and records a diagnostic", async () => {
    await withProxy(async ({ ledger, port, upstream }) => {
      const reply = await throughProxy(port, `${upstream.url}/large`);
      expect(reply.status).toBe(402);
      expect(reply.body.equals(Buffer.alloc(100_000, 255))).toBe(true);
      expect(ledger.diagnostics()).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "parse_failed" })]),
      );
      expect(ledger.events()).toEqual([]);
    });
  });

  test("a streamed POST and its escaped query survive malformed payment metadata unchanged", async () => {
    await withProxy(async ({ ledger, port, upstream }) => {
      const path = "/echo?escaped=%2F%3F%26&space=a%20b&plus=a+b&repeat=1&repeat=2";
      const chunks = [
        Buffer.from([0, 255, 1]),
        Buffer.alloc(70_000, 42),
        Buffer.from([128, 13, 10]),
      ];
      const reply = await throughProxy(port, `${upstream.url}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream", "Payment-Signature": "invalid" },
        body: chunks,
      });
      expect(reply.status).toBe(200);
      expect(reply.body.equals(Buffer.concat(chunks))).toBe(true);
      expect(upstream.requests).toEqual([
        expect.objectContaining({ method: "POST", url: path, body: Buffer.concat(chunks) }),
      ]);
      expect(ledger.events()).toEqual([]);
      expect(ledger.diagnostics()).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "parse_failed" })]),
      );
    });
  });

  test("response trailers and duplicate Set-Cookie headers remain intact", async () => {
    await withProxy(async ({ port, upstream }) => {
      const reply = await throughProxy(port, `${upstream.url}/trailers`);
      expect(reply.status).toBe(200);
      expect(reply.body.toString("utf8")).toBe("firstsecond");
      expect(reply.headers["set-cookie"]).toEqual(["a=1", "b=2"]);
      expect(reply.trailers["x-fixture-end"]).toBe("yes");
      expect(
        reply.rawHeaders.filter((header) => header.toLowerCase() === "set-cookie"),
      ).toHaveLength(2);
    });
  });

  test("upstream 5xx without settlement evidence preserves unknown monetary exposure", async () => {
    await withProxy(async ({ ledger, port, upstream }) => {
      const resource = `${upstream.url}/v2?status=503&settlement=none`;
      const reply = await throughProxy(port, resource, { headers: paymentHeader(2, 1, resource) });
      expect(reply.status).toBe(503);
      expect(reply.body.toString("utf8")).toBe('{"ok":false}');
      expect(ledger.view()).toEqual([
        expect.objectContaining({ settlementStatus: "unknown", settlement_unknown: true }),
      ]);
      expect(totals(ledger.view())).toEqual([
        expect.objectContaining({ amount: "7", unknownAmount: "7", confirmedAmount: "0" }),
      ]);
      expect(ledger.diagnostics()).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "settlement_unknown" })]),
      );
    });
  });

  test("an upstream disconnect after receiving authorization cannot erase exposure", async () => {
    await withProxy(async ({ ledger, port, upstream }) => {
      const resource = `${upstream.url}/disconnect`;
      const reply = await throughProxy(port, resource, {
        headers: paymentHeader(2, 1, resource),
      }).catch(() => null);
      expect(reply === null || reply.status >= 500).toBe(true);
      expect(upstream.paid()).toBe(1);
      expect(ledger.view()).toEqual([
        expect.objectContaining({ settlementStatus: "unknown", settlement_unknown: true }),
      ]);
      expect(totals(ledger.view())).toEqual([expect.objectContaining({ amount: "7" })]);
    });
  });

  test("explicit failed settlement releases exposure and makes the budget available again", async () => {
    await withProxy(async ({ ledger, port, upstream }) => {
      const failure = `${upstream.url}/v2?settlement=failed`;
      expect(
        (await throughProxy(port, failure, { headers: paymentHeader(2, 1, failure) })).status,
      ).toBe(200);
      expect(ledger.view()[0]?.settlementStatus).toBe("failed");
      expect(totals(ledger.view())).toEqual([]);
      const success = `${upstream.url}/v2`;
      expect(
        (await throughProxy(port, success, { headers: paymentHeader(2, 2, success) })).status,
      ).toBe(200);
      expect(upstream.paid()).toBe(2);
      expect(totals(ledger.view())).toEqual([expect.objectContaining({ amount: "7" })]);
    }, cap("7"));
  });

  test("a failed duplicate cannot release the reservation for another pending attempt", async () => {
    await withProxy(async ({ ledger, port, upstream }) => {
      const pendingResource = `${upstream.url}/v2?delay=150&settlement=none`;
      const arrived = new Promise<void>((resolve) =>
        upstream.server.once("request", () => resolve()),
      );
      const pending = throughProxy(port, pendingResource, {
        headers: paymentHeader(2, 1, pendingResource),
      });
      await arrived;
      const failure = `${upstream.url}/v2?settlement=failed`;
      expect(
        (await throughProxy(port, failure, { headers: paymentHeader(2, 1, failure) })).status,
      ).toBe(200);
      expect(ledger.view()[0]?.settlementStatus).toBe("unknown");
      expect(totals(ledger.view())).toEqual([expect.objectContaining({ amount: "7" })]);
      const next = `${upstream.url}/v2`;
      expect((await throughProxy(port, next, { headers: paymentHeader(2, 2, next) })).status).toBe(
        402,
      );
      expect((await pending).status).toBe(200);
      expect(upstream.paid()).toBe(2);
      expect(totals(ledger.view())).toEqual([expect.objectContaining({ amount: "7" })]);
    }, cap("7"));
  });

  test("explicit upstream configuration maps origin-form requests without changing path or query", async () => {
    await withProxy(
      async ({ port, upstream }) => {
        const path = "/echo?escaped=%2f%3F&space=a%20b&empty=";
        const body = Buffer.from([0, 42, 255, 128]);
        const reply = await throughProxy(port, path, { method: "POST", body: [body] });
        expect(reply.status).toBe(200);
        expect(reply.body.equals(body)).toBe(true);
        expect(upstream.requests).toEqual([
          expect.objectContaining({ url: path, method: "POST", body }),
        ]);
      },
      {},
      true,
    );
  });

  test("CONNECT transparently tunnels TCP bytes and records that TLS is unmetered", async () => {
    const sockets = new Set<Socket>();
    const echo = createTcpServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.pipe(socket);
    });
    await new Promise<void>((resolve, reject) => {
      echo.once("error", reject);
      echo.listen(0, "127.0.0.1", () => {
        echo.off("error", reject);
        resolve();
      });
    });
    const echoPort = z.object({ port: z.number() }).parse(echo.address()).port;
    try {
      await withProxy(async ({ ledger, port }) => {
        const payload = Buffer.from([0, 255, 128, 13, 10, 1, 2, 3]);
        const received = await new Promise<Buffer>((resolve, reject) => {
          const req = request({
            hostname: "127.0.0.1",
            port,
            method: "CONNECT",
            path: `127.0.0.1:${echoPort}`,
            agent: false,
          });
          req.once("error", reject);
          req.setTimeout(5000, () => req.destroy(new Error("CONNECT request timed out")));
          req.once("connect", (response, socket, head) => {
            if (response.statusCode !== 200) {
              socket.destroy();
              reject(new Error(`CONNECT returned ${response.statusCode}`));
              return;
            }
            const chunks: Buffer[] = [head];
            socket.once("error", reject);
            socket.setTimeout(5000, () => socket.destroy(new Error("CONNECT echo timed out")));
            socket.on("data", (chunk: unknown) => {
              chunks.push(z.instanceof(Buffer).parse(chunk));
              const body = Buffer.concat(chunks);
              if (body.length >= payload.length) {
                socket.destroy();
                resolve(body);
              }
            });
            socket.write(payload);
          });
          req.end();
        });
        expect(received.equals(payload)).toBe(true);
        expect(ledger.events()).toEqual([]);
        expect(ledger.diagnostics()).toEqual(
          expect.arrayContaining([expect.objectContaining({ code: "tls_unmetered" })]),
        );
      });
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        echo.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
