import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { type IncomingHttpHeaders, request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { runCli } from "../src/cli/program";
import { parseConfig } from "../src/config";
import { totalSchema, totals } from "../src/ledger/derive";
import { Ledger } from "../src/ledger/store";
import type { PaymentEvent } from "../src/model";
import { createDashboard } from "../src/server/index";
import { dashboardStateSchema } from "../src/server/schema";
import { dashboardState } from "../src/server/state";
import { listen, stop } from "./fixtures/upstream";
import { event } from "./helpers";

type Reply = { status: number; headers: IncomingHttpHeaders; body: Buffer };
function get(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string> } = {},
): Promise<Reply> {
  return new Promise((resolveReply, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path, agent: false, ...options }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: unknown) => chunks.push(z.instanceof(Buffer).parse(chunk)));
      res.once("error", reject);
      res.once("end", () =>
        resolveReply({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks),
        }),
      );
    });
    req.once("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error("Dashboard test request timed out")));
    req.end();
  });
}

type Context = { ledger: Ledger; port: number; directory: string; db: string; uiRoot: string };
async function withDashboard(run: (context: Context) => Promise<void>, patch: unknown = {}) {
  const prefix = join(tmpdir(), "taximeter-server-test-");
  const directory = mkdtempSync(prefix);
  if (!resolve(directory).startsWith(resolve(prefix))) throw new Error("Unsafe cleanup path");
  const uiRoot = join(directory, "ui");
  mkdirSync(join(uiRoot, "assets"), { recursive: true });
  writeFileSync(join(uiRoot, "index.html"), "<!doctype html><title>Taximeter fixture</title>");
  writeFileSync(join(uiRoot, "assets", "app.js"), 'document.title = "Taximeter fixture";');
  writeFileSync(join(uiRoot, "assets", "app.css"), "body{color:teal}");
  writeFileSync(join(uiRoot, "assets", "font.woff2"), Buffer.from([0, 255, 1, 128]));
  writeFileSync(join(uiRoot, "private.db"), "PRIVATE-UI-FILE");
  writeFileSync(join(directory, "secret.js"), "OUTSIDE-UI-SECRET");
  const db = join(directory, "ledger.db");
  const ledger = new Ledger(db);
  const server = createDashboard({ ledger, config: parseConfig(patch), uiRoot });
  try {
    const port = await listen(server);
    await run({ ledger, port, directory, db, uiRoot });
  } finally {
    if (server.listening) await stop(server);
    ledger.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function seed(ledger: Ledger): PaymentEvent[] {
  const ts = new Date().toISOString();
  const events = [
    event({
      amount: "11",
      ts,
      taskId: "task-a",
      agentId: "agent-a",
      host: "one.test",
      raw: "PRIVATE-AUTHORIZATION",
      settlementStatus: "confirmed",
      settlement_unknown: false,
    }),
    event({ amount: "13", ts, taskId: "task-a", agentId: "agent-b", host: "one.test" }),
    event({ amount: "17", ts, taskId: "task-b", agentId: "agent-a", host: "two.test" }),
    event({
      amount: "19",
      ts,
      taskId: "task-a",
      agentId: "agent-b",
      host: "one.test",
      asset: "0x3333333333333333333333333333333333333333",
      decimals: 0,
      decimalsKnown: false,
      assetSymbol: undefined,
    }),
    event({ amount: "23", ts, taskId: undefined, agentId: undefined, host: "one.test" }),
    event({ amount: "900", ts, status: "blocked", taskId: "task-a" }),
    event({
      amount: "999",
      ts,
      settlementStatus: "failed",
      settlement_unknown: false,
      taskId: "task-b",
    }),
  ];
  for (const value of events) ledger.append(value);
  return events;
}

describe("local read-only dashboard API", () => {
  test("empty state is valid JSON with useful defaults and no cached or credential data", async () => {
    await withDashboard(async ({ port }) => {
      const response = await get(port, "/api/summary");
      expect(response.status).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["content-type"]).toContain("application/json");
      const state = dashboardStateSchema.parse(JSON.parse(response.body.toString("utf8")));
      expect(state).toMatchObject({
        version: "0.1.0",
        totalEvents: 0,
        blockedEvents: 0,
        unknownEvents: 0,
        events: [],
        totals: [],
        groups: { task: [], agent: [], host: [] },
        proxy: { port: 8402 },
      });
      expect(state.hours).toHaveLength(24);
      expect(state.globalBudget?.amount).toBe("100000000");
      expect(response.headers["access-control-allow-origin"]).toBeUndefined();
      expect(response.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
    });
  });

  test("summary groups preserve asset identities and exclude blocked or failed money", async () => {
    await withDashboard(async ({ port, ledger }) => {
      const events = seed(ledger);
      const response = await get(port, "/api/summary");
      const state = dashboardStateSchema.parse(JSON.parse(response.body.toString("utf8")));
      expect(state.totalEvents).toBe(7);
      expect(state.blockedEvents).toBe(1);
      expect(state.unknownEvents).toBe(4);
      expect(state.totals).toEqual(totals(events));
      expect(state.totals.map((total) => total.amount).sort()).toEqual(["19", "64"]);
      expect(state.groups.task).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: "task-a", assetSymbol: "USDC", amount: "24" }),
          expect.objectContaining({ key: "task-b", assetSymbol: "USDC", amount: "17" }),
          expect.objectContaining({ key: null, assetSymbol: "USDC", amount: "23" }),
          expect.objectContaining({
            key: "task-a",
            asset: "0x3333333333333333333333333333333333333333",
            amount: "19",
          }),
        ]),
      );
      expect(state.groups.agent).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: "agent-a", assetSymbol: "USDC", amount: "28" }),
          expect.objectContaining({ key: "agent-b", assetSymbol: "USDC", amount: "13" }),
        ]),
      );
      expect(state.groups.host).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: "one.test", assetSymbol: "USDC", amount: "47" }),
          expect.objectContaining({ key: "two.test", assetSymbol: "USDC", amount: "17" }),
        ]),
      );
      expect(response.body.toString("utf8")).not.toContain("PRIVATE-AUTHORIZATION");
      expect(response.body.toString("utf8")).not.toContain('"raw"');
    });
  });

  test("summary shows newest 30 events and newest ten diagnostics without limiting all-time totals", async () => {
    await withDashboard(async ({ port, ledger }) => {
      const current = Date.now();
      const inserted = Array.from({ length: 35 }, (_, index) =>
        event({ amount: "7", ts: new Date(current - index * 60_000).toISOString() }),
      );
      for (const value of [...inserted].reverse()) ledger.append(value);
      for (let index = 0; index < 12; index += 1)
        ledger.diagnose("parse_failed", "fixture", `diagnostic-${index}`);
      const state = dashboardStateSchema.parse(
        JSON.parse((await get(port, "/api/summary")).body.toString("utf8")),
      );
      expect(state.events.map((value) => value.id)).toEqual(
        inserted.slice(0, 30).map((value) => value.id),
      );
      expect(state.totalEvents).toBe(35);
      expect(state.totals[0]?.amount).toBe("245");
      expect(state.diagnostics.map((value) => value.message)).toEqual(
        Array.from({ length: 10 }, (_, index) => `diagnostic-${11 - index}`),
      );
    });
  });

  test.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])(
    "%s cannot mutate or export the ledger",
    async (method) => {
      await withDashboard(async ({ ledger, port }) => {
        seed(ledger);
        const before = ledger.events();
        const response = await get(port, "/api/summary", { method });
        expect(response.status).toBe(405);
        expect(response.headers.allow).toBe("GET, HEAD");
        expect(JSON.parse(response.body.toString("utf8"))).toEqual({ error: "read_only" });
        expect(ledger.events()).toEqual(before);
      });
    },
  );

  test("HEAD returns normal headers without a response body", async () => {
    await withDashboard(async ({ port }) => {
      for (const path of ["/", "/api/summary", "/api/export?format=csv"]) {
        const response = await get(port, path, { method: "HEAD" });
        expect(response.status).toBe(200);
        expect(response.body.length).toBe(0);
        expect(response.headers["content-type"]).toBeDefined();
      }
    });
  });

  test.each([
    { Host: "attacker.example" },
    { Host: "127.0.0.1:1" },
    { Origin: "https://attacker.example" },
    { Origin: "null" },
    { "Sec-Fetch-Site": "cross-site" },
  ])("rejects foreign browser origin or rebinding metadata %j", async (headers) => {
    await withDashboard(async ({ port, ledger }) => {
      seed(ledger);
      const response = await get(port, "/api/summary", {
        headers: z.record(z.string(), z.string()).parse(headers),
      });
      expect(response.status).toBe(403);
      expect(JSON.parse(response.body.toString("utf8"))).toEqual({
        error: "local_origin_required",
      });
      expect(response.body.toString("utf8")).not.toContain("PRIVATE-AUTHORIZATION");
      expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    });
  });

  test("accepts localhost and matching loopback browser origins", async () => {
    await withDashboard(async ({ port }) => {
      for (const host of ["localhost", "127.0.0.1"]) {
        expect(
          (
            await get(port, "/api/summary", {
              headers: {
                Host: `${host}:${port}`,
                Origin: `http://${host}:${port}`,
                "Sec-Fetch-Site": "same-origin",
              },
            })
          ).status,
        ).toBe(200);
      }
    });
  });

  test.each([
    "/api/summary?unexpected=true",
    "/api/export?format=xml",
    "/api/export?format=invalid&format=json",
    "/api/export?format=csv&format=json",
    "/%E0%A4%A",
    "http://attacker.example/api/summary",
    "//attacker.example/api/summary",
  ])("rejects invalid query or request target %s", async (path) => {
    await withDashboard(async ({ port }) => {
      expect((await get(port, path)).status).toBe(400);
    });
  });

  test.each(["/..%2fsecret.js", "/%2e%2e%5csecret.js"])(
    "encoded traversal %s cannot read outside the UI root",
    async (path) => {
      await withDashboard(async ({ port }) => {
        const response = await get(port, path);
        expect([400, 403, 404]).toContain(response.status);
        expect(response.body.toString("utf8")).not.toContain("OUTSIDE-UI-SECRET");
      });
    },
  );

  test("serves local UI assets with correct media types and denies unlisted files", async () => {
    await withDashboard(async ({ port }) => {
      const index = await get(port, "/");
      expect(index.status).toBe(200);
      expect(index.body.toString("utf8")).toBe("<!doctype html><title>Taximeter fixture</title>");
      expect(index.headers["content-type"]).toContain("text/html");
      expect(index.headers["cache-control"]).toBe("no-cache");
      for (const [path, type] of [
        ["/assets/app.js", "text/javascript"],
        ["/assets/app.css", "text/css"],
        ["/assets/font.woff2", "font/woff2"],
      ]) {
        if (!path || !type) throw new Error("Invalid asset fixture");
        const response = await get(port, path);
        expect(response.status).toBe(200);
        expect(response.headers["content-type"]).toContain(type);
      }
      expect(
        (await get(port, "/assets/font.woff2")).body.equals(Buffer.from([0, 255, 1, 128])),
      ).toBe(true);
      for (const path of ["/private.db", "/assets", "/does-not-exist.js", "/api/does-not-exist"]) {
        const response = await get(port, path);
        expect(response.status).toBe(404);
        expect(response.body.toString("utf8")).not.toContain("PRIVATE-UI-FILE");
      }
    });
  });

  test("export endpoint provides valid attachments in each supported format", async () => {
    await withDashboard(async ({ port, ledger }) => {
      seed(ledger);
      for (const format of ["csv", "json", "invoice"]) {
        const response = await get(port, `/api/export?format=${format}`);
        expect(response.status).toBe(200);
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(response.headers["content-disposition"]).toBe(
          `attachment; filename="taximeter.${format === "invoice" ? "html" : format}"`,
        );
        if (format === "json")
          expect(
            z
              .object({ totals: z.array(totalSchema) })
              .parse(JSON.parse(response.body.toString("utf8"))).totals,
          ).toEqual(totals(ledger.view()));
        if (format === "csv")
          expect(response.body.toString("utf8")).toContain('"authorizedAmount"');
        if (format === "invoice")
          expect(response.body.toString("utf8")).toMatch(/<!doctype html>/i);
      }
    });
  });

  test("CLI CSV counted amounts equal actual dashboard totals exactly for multiple assets", async () => {
    await withDashboard(async ({ port, ledger, directory, db }) => {
      seed(ledger);
      ledger.append(event({ amount: "900719925474099312345678901234567890" }));
      const response = await get(port, "/api/summary");
      const state = dashboardStateSchema.parse(JSON.parse(response.body.toString("utf8")));
      const path = join(directory, "actual CLI statement.csv");
      await runCli(["export", "--db", db, "--csv", path], () => {});
      const lines = readFileSync(path, "utf8").trimEnd().split("\r\n");
      const header = lines
        .shift()
        ?.split(",")
        .map((value) => JSON.parse(value));
      const names = z.array(z.string()).parse(header);
      const counted = new Map<string, bigint>();
      for (const line of lines) {
        const values = z.array(z.string()).parse(line.split(",").map((value) => JSON.parse(value)));
        const row = z
          .object({ amount: z.string().regex(/^[0-9]+$/), asset: z.string(), network: z.string() })
          .parse(Object.fromEntries(names.map((name, index) => [name, values[index]])));
        if (row.amount === "0") continue;
        const key = `${row.network}/${row.asset}`;
        counted.set(key, (counted.get(key) ?? 0n) + BigInt(row.amount));
      }
      const csvAmounts = Object.fromEntries(
        [...counted].map(([key, amount]) => [key, amount.toString()]),
      );
      expect(csvAmounts).toEqual(
        Object.fromEntries(
          state.totals.map((total) => [`${total.network}/${total.asset}`, total.amount]),
        ),
      );
      expect(Object.values(csvAmounts)).toContain("900719925474099312345678901234567954");
    });
  });
});

describe("dashboard state windows", () => {
  test("rolling budget boundaries, renewed exposure, and remaining amounts use exact arithmetic", () => {
    const ledger = new Ledger(":memory:");
    const now = Date.parse("2026-09-08T12:30:00.000Z");
    const start = now - 86_400_000;
    try {
      for (const [ts, amount] of [
        [start, "11"],
        [start - 1, "13"],
        [now + 1, "17"],
        [now, "19"],
      ] as const)
        ledger.append(event({ ts: new Date(ts).toISOString(), amount }));
      ledger.append(
        event({
          ts: "2026-09-06T12:00:00.000Z",
          attemptedAt: "2026-09-08T11:00:00.000Z",
          amount: "23",
        }),
      );
      const state = dashboardState(
        ledger,
        parseConfig({ budgets: { global: { amount: "50", asset: "USDC", window: "24h" } } }),
        now,
      );
      expect(state.totals[0]?.amount).toBe("83");
      expect(state.budgets).toEqual([
        expect.objectContaining({ limit: "50", spent: "53", remaining: "0", window: "24h" }),
      ]);
    } finally {
      ledger.close();
    }
  });

  test("24 chronological hourly buckets retain asset separation and ignore future or failed rows", () => {
    const ledger = new Ledger(":memory:");
    const now = Date.parse("2026-09-08T12:30:00.000Z");
    try {
      ledger.append(event({ ts: "2026-09-07T13:00:00.000Z", amount: "11" }));
      ledger.append(event({ ts: "2026-09-07T12:59:59.999Z", amount: "13" }));
      ledger.append(event({ ts: "2026-09-08T12:30:00.001Z", amount: "17" }));
      ledger.append(event({ ts: "2026-09-08T12:00:00.000Z", amount: "19" }));
      ledger.append(
        event({
          ts: "2026-09-08T12:00:00.000Z",
          amount: "999",
          settlementStatus: "failed",
          settlement_unknown: false,
        }),
      );
      ledger.append(
        event({
          ts: "2026-09-08T12:00:00.000Z",
          amount: "23",
          network: "eip155:1",
          assetSymbol: undefined,
        }),
      );
      const state = dashboardState(ledger, parseConfig({ budgets: { global: null } }), now);
      expect(state.hours).toHaveLength(24);
      expect(state.hours[0]).toMatchObject({
        ts: "2026-09-07T13:00:00.000Z",
        totals: [expect.objectContaining({ amount: "11" })],
      });
      expect(state.hours[1]?.totals).toEqual([]);
      expect(state.hours.at(-1)?.ts).toBe("2026-09-08T12:00:00.000Z");
      expect(
        state.hours
          .at(-1)
          ?.totals.map((total) => total.amount)
          .sort(),
      ).toEqual(["19", "23"]);
      expect(state.budgets).toEqual([]);
      expect(state.globalBudget).toBeNull();
    } finally {
      ledger.close();
    }
  });
});
