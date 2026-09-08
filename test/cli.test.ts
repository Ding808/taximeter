import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http, { createServer, type Server } from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { runCli } from "../src/cli/program";
import { parseConfig } from "../src/config";
import { expandPath, loadConfig } from "../src/config/io";
import { Ledger } from "../src/ledger/store";
import { startServices } from "../src/server/lifecycle";
import { event } from "./helpers";

const TEMP_PREFIX = join(tmpdir(), "taximeter-cli-test-");
const directories: string[] = [];
const cleanup: (() => Promise<void>)[] = [];

beforeEach(() => {
  vi.stubEnv("TAXIMETER_DB", undefined);
  vi.stubEnv("TAXIMETER_PORT", undefined);
  vi.stubEnv("TAXIMETER_DASHBOARD_PORT", undefined);
});

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const path of directories.splice(0)) {
    if (!resolve(path).startsWith(resolve(TEMP_PREFIX)))
      throw new Error("Unsafe test cleanup path");
    rmSync(path, { recursive: true, force: true });
  }
});

function workspace() {
  const root = mkdtempSync(TEMP_PREFIX);
  directories.push(root);
  const cwd = join(root, "working directory");
  const home = join(root, "home directory");
  mkdirSync(cwd);
  mkdirSync(join(home, ".taximeter"), { recursive: true });
  return { root, cwd, home, db: join(root, "ledger with spaces.db") };
}

function json(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value), "utf8");
}

async function cli(argv: string[]): Promise<string> {
  const output: string[] = [];
  await runCli(argv, (chunk) => output.push(chunk));
  return output.join("");
}

function seed(db: string): void {
  const ledger = new Ledger(db);
  try {
    ledger.append(event({ amount: "900719925474099312345678", taskId: "task-large" }));
    ledger.append(event({ amount: "2", taskId: "task-small", agentId: "agent-other" }));
    ledger.append(event({ amount: "999", status: "blocked", settlement_unknown: false }));
  } finally {
    ledger.close();
  }
}

const totalList = z.array(z.object({ amount: z.string(), network: z.string(), asset: z.string() }));

async function start(db: string, ports = { proxy: 0, dashboard: 0 }) {
  const running = await startServices(parseConfig({ db, ports }));
  cleanup.push(() => running.close());
  return running;
}

async function stopServer(server: Server): Promise<void> {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise<void>((done, reject) =>
    server.close((error) => (error ? reject(error) : done())),
  );
}

async function listener(port = 0): Promise<{ server: Server; port: number }> {
  const server = createServer((_request, response) => response.end("fixture"));
  cleanup.push(() => stopServer(server));
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      done();
    });
  });
  const address = z.object({ port: z.number() }).parse(server.address());
  return { server, port: address.port };
}

describe("configuration sources and path portability", () => {
  test("no config files produce documented defaults under the injected home", () => {
    const { cwd, home } = workspace();
    const config = loadConfig({}, { cwd, home, env: {} });
    expect(config.db).toBe(join(home, ".taximeter", "ledger.db"));
    expect(config.ports).toEqual({ proxy: 8402, dashboard: 8403 });
    expect(config.budgets.global?.amount).toBe("100000000");
  });

  test("precedence is flags, environment, explicit file, cwd, home, defaults", () => {
    const { cwd, home } = workspace();
    json(join(home, ".taximeter", "config.json"), {
      ports: { proxy: 1111, dashboard: 1112 },
      budgets: { global: { amount: "111" } },
      db: "home.db",
    });
    json(join(cwd, "taximeter.config.json"), {
      ports: { proxy: 2222, dashboard: 2223 },
      policy: { denyHosts: ["blocked.example.test"] },
      db: "cwd.db",
    });
    json(join(cwd, "explicit.json"), {
      ports: { proxy: 3333 },
      budgets: { perTask: { amount: "333" } },
      db: "explicit.db",
    });
    const sources = { cwd, home, configFile: "explicit.json" };
    expect(loadConfig({}, { ...sources, env: {} }).ports.proxy).toBe(3333);
    expect(loadConfig({}, { ...sources, env: {} }).db).toBe(join(cwd, "explicit.db"));
    const environment = { TAXIMETER_PORT: "4444", TAXIMETER_DB: "env.db" };
    expect(loadConfig({}, { ...sources, env: environment }).ports.proxy).toBe(4444);
    expect(loadConfig({}, { ...sources, env: environment }).db).toBe(join(cwd, "env.db"));
    const config = loadConfig(
      { ports: { proxy: 5555 }, db: "flag.db" },
      { ...sources, env: environment },
    );
    expect(config.ports).toEqual({ proxy: 5555, dashboard: 2223 });
    expect(config.db).toBe(join(cwd, "flag.db"));
    expect(config.budgets.global?.amount).toBe("111");
    expect(config.budgets.perTask?.amount).toBe("333");
    expect(config.policy.denyHosts).toEqual(["blocked.example.test"]);
  });

  test("cwd values override home while omitted siblings remain", () => {
    const { cwd, home } = workspace();
    json(join(home, ".taximeter", "config.json"), { ports: { proxy: 1111, dashboard: 1112 } });
    json(join(cwd, "taximeter.config.json"), { ports: { proxy: 2222 } });
    expect(loadConfig({}, { cwd, home, env: {} }).ports).toEqual({ proxy: 2222, dashboard: 1112 });
  });

  test("port zero is preserved in environment and flags", () => {
    const { cwd, home } = workspace();
    expect(
      loadConfig({}, { cwd, home, env: { TAXIMETER_PORT: "0", TAXIMETER_DASHBOARD_PORT: "0" } })
        .ports,
    ).toEqual({ proxy: 0, dashboard: 0 });
    expect(
      loadConfig({ ports: { proxy: 0 } }, { cwd, home, env: { TAXIMETER_PORT: "9999" } }).ports
        .proxy,
    ).toBe(0);
  });

  test.each(["", " ", " 80", "80 ", "1e3", "0x20", "+20", "1.5", "-1", "65536"])(
    "rejects a non-decimal or out-of-range environment port %j",
    (value) => {
      const { cwd, home } = workspace();
      expect(() => loadConfig({}, { cwd, home, env: { TAXIMETER_PORT: value } })).toThrow();
    },
  );

  test("missing explicit file fails while absent auto-discovered files are allowed", () => {
    const { cwd, home } = workspace();
    expect(() => loadConfig({}, { cwd, home, env: {} })).not.toThrow();
    expect(() => loadConfig({}, { cwd, home, env: {}, configFile: "missing.json" })).toThrow(
      /not found/i,
    );
  });

  test.each(["malformed", "unknown-key"])("invalid %s config is never silently ignored", (kind) => {
    const { cwd, home } = workspace();
    writeFileSync(
      join(cwd, "taximeter.config.json"),
      kind === "malformed" ? "{ broken" : '{"unknownKey":true}',
    );
    expect(() => loadConfig({}, { cwd, home, env: {} })).toThrow(/configuration/i);
  });

  test("expands both home path separators and preserves absolute or memory paths", () => {
    const { cwd, home, db } = workspace();
    expect(expandPath("~", home, cwd)).toBe(home);
    expect(expandPath("~/ledger.db", home, cwd)).toBe(join(home, "ledger.db"));
    expect(expandPath("~\\ledger.db", home, cwd)).toBe(join(home, "ledger.db"));
    expect(expandPath("relative ledger.db", home, cwd)).toBe(join(cwd, "relative ledger.db"));
    expect(expandPath(db, home, cwd)).toBe(db);
    expect(expandPath(":memory:", home, cwd)).toBe(":memory:");
  });
});

describe("report, export, reset, and local doctor", () => {
  test("JSON report totals are exact integer strings and exclude blocked attempts", async () => {
    const { db } = workspace();
    seed(db);
    const result = totalList.parse(JSON.parse(await cli(["report", "--db", db, "--json"])));
    expect(result).toHaveLength(1);
    expect(result[0]?.amount).toBe("900719925474099312345680");
  });

  test("text report displays exact decimal strings with network and uncertainty", async () => {
    const { db } = workspace();
    seed(db);
    const output = await cli(["report", "--db", db]);
    expect(output).toContain("900719925474099312.345680 USDC");
    expect(output).toContain("eip155:8453");
    expect(output).toContain("900719925474099312345680 atomic units uncertain");
  });

  test("report filters attribution without affecting another task's total", async () => {
    const { db } = workspace();
    seed(db);
    const output = await cli([
      "report",
      "--db",
      db,
      "--json",
      "--task",
      "task-small",
      "--agent",
      "agent-other",
      "--host",
      "api.example.test",
    ]);
    expect(totalList.parse(JSON.parse(output))[0]?.amount).toBe("2");
  });

  test("an empty existing ledger has a meaningful report", async () => {
    const { db } = workspace();
    new Ledger(db).close();
    expect(await cli(["report", "--db", db])).toContain("No payments recorded");
    expect(JSON.parse(await cli(["report", "--db", db, "--json"]))).toEqual([]);
  });

  test("JSON export writes exact events and totals to a path with spaces", async () => {
    const { root, db } = workspace();
    seed(db);
    const path = join(root, "statement with spaces.json");
    const output = await cli(["export", "--db", db, "--json", path]);
    expect(output).toContain(path);
    const data = z
      .object({ events: z.array(z.object({ amount: z.string() })), totals: totalList })
      .parse(JSON.parse(readFileSync(path, "utf8")));
    expect(data.events).toHaveLength(3);
    expect(data.totals[0]?.amount).toBe("900719925474099312345680");
  });

  test("export does not overwrite an existing user file", async () => {
    const { root, db } = workspace();
    seed(db);
    const path = join(root, "important.json");
    writeFileSync(path, "keep this original content");
    await expect(cli(["export", "--db", db, "--json", path])).rejects.toThrow();
    expect(readFileSync(path, "utf8")).toBe("keep this original content");
  });

  test("reset requires --yes and preserves the original ledger when omitted", async () => {
    const { db } = workspace();
    seed(db);
    await expect(cli(["reset", "--db", db])).rejects.toThrow(/--yes/);
    expect(existsSync(db)).toBe(true);
    expect(
      totalList.parse(JSON.parse(await cli(["report", "--db", db, "--json"])))[0]?.amount,
    ).toBe("900719925474099312345680");
  });

  test("reset archives every event instead of deleting the ledger contents", async () => {
    const { root, db } = workspace();
    seed(db);
    expect(await cli(["reset", "--db", db, "--yes"])).toMatch(/Archived/);
    expect(existsSync(db)).toBe(false);
    const archives = readdirSync(root).filter(
      (name) => name.includes(".archive-") && name.endsWith(".db"),
    );
    expect(archives).toHaveLength(1);
    const name = archives[0];
    if (!name) throw new Error("Expected archive file");
    const archive = new Ledger(join(root, name));
    try {
      expect(archive.events()).toHaveLength(3);
      expect(archive.events().some((row) => row.amount === "900719925474099312345678")).toBe(true);
    } finally {
      archive.close();
    }
  });

  test("reset refuses a ledger while its services hold the lock", async () => {
    const { db } = workspace();
    seed(db);
    const running = await start(db);
    await expect(cli(["reset", "--db", db, "--yes"])).rejects.toThrow(/running|use|stop|lock/i);
    expect(running.ledger.events()).toHaveLength(3);
    expect(existsSync(db)).toBe(true);
  });

  test("doctor checks config and SQLite without HTTP requests", async () => {
    const { db } = workspace();
    new Ledger(db).close();
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Network forbidden in doctor"));
    const request = vi.spyOn(http, "request").mockImplementation(() => {
      throw new Error("HTTP forbidden in doctor");
    });
    const secureRequest = vi.spyOn(https, "request").mockImplementation(() => {
      throw new Error("HTTPS forbidden in doctor");
    });
    const output = await cli(["doctor", "--db", db]);
    expect(output).toContain("Configuration: valid");
    expect(output).toContain("SQLite: ready");
    expect(output).toContain("Network checks: none");
    expect(fetch).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(secureRequest).not.toHaveBeenCalled();
  });
});

describe("service startup and cleanup", () => {
  test("port zero starts two different real loopback listeners", async () => {
    const { db } = workspace();
    const running = await start(db);
    expect(running.proxyPort).toBeGreaterThan(0);
    expect(running.dashboardPort).toBeGreaterThan(0);
    expect(running.proxyPort).not.toBe(running.dashboardPort);
    expect(running.proxy.address()).toMatchObject({ address: "127.0.0.1" });
    expect(running.dashboard.address()).toMatchObject({ address: "127.0.0.1" });
    const response = await fetch(`http://127.0.0.1:${running.dashboardPort}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Taximeter");
    expect(existsSync(`${db}.lock`)).toBe(true);
  });

  test("repeated close releases listeners and the database lock", async () => {
    const { db } = workspace();
    const running = await start(db);
    await running.close();
    await running.close();
    expect(running.proxy.listening).toBe(false);
    expect(running.dashboard.listening).toBe(false);
    expect(existsSync(`${db}.lock`)).toBe(false);
    const proxy = await listener(running.proxyPort);
    const dashboard = await listener(running.dashboardPort);
    expect(proxy.server.listening && dashboard.server.listening).toBe(true);
  });

  test("a second instance cannot claim a running ledger", async () => {
    const { db } = workspace();
    const running = await start(db);
    await expect(
      startServices(parseConfig({ db, ports: { proxy: 0, dashboard: 0 } })),
    ).rejects.toThrow(/running|use|stop|lock/i);
    expect(running.proxy.listening).toBe(true);
  });

  test("second-port failure rolls back the first listener and releases its lock", async () => {
    const { db } = workspace();
    const occupied = await listener();
    const spare = await listener();
    await stopServer(spare.server);
    await expect(
      startServices(parseConfig({ db, ports: { proxy: spare.port, dashboard: occupied.port } })),
    ).rejects.toThrow();
    expect(existsSync(`${db}.lock`)).toBe(false);
    const rebound = await listener(spare.port);
    expect(rebound.server.listening).toBe(true);
    const restarted = await start(db);
    expect(restarted.dashboard.listening).toBe(true);
  });
});
