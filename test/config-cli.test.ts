import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { runCli } from "../src/cli/program";
import { type ConfigLoadOptions, loadConfig } from "../src/config/io";
import { blockedBodySchema } from "../src/model";
import * as lifecycle from "../src/server/lifecycle";
import { fixtureUpstream, paymentHeader } from "./fixtures/upstream";

const prefix = join(tmpdir(), "taximeter-config-cli-");
const directories: string[] = [];
const cleanup: (() => Promise<void>)[] = [];
const signals: { event: "SIGINT" | "SIGTERM"; listener: NodeJS.SignalsListener }[] = [];

afterEach(async () => {
  for (const item of signals.splice(0)) process.off(item.event, item.listener);
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  for (const path of directories.splice(0)) {
    if (!resolve(path).startsWith(resolve(prefix))) throw new Error("Unsafe test cleanup path");
    rmSync(path, { recursive: true, force: true });
  }
});

function workspace() {
  const root = mkdtempSync(prefix);
  directories.push(root);
  const cwd = join(root, "project");
  const home = join(root, "home");
  mkdirSync(cwd);
  mkdirSync(join(home, ".taximeter"), { recursive: true });
  return {
    root,
    cwd,
    home,
    env: {},
    cwdFile: join(cwd, "taximeter.config.json"),
    homeFile: join(home, ".taximeter", "config.json"),
    db: join(root, "ledger.db"),
  };
}

async function cli(argv: string[], sources: ConfigLoadOptions): Promise<string> {
  const output: string[] = [];
  const original = new Map(
    (["SIGINT", "SIGTERM"] as const).map((event) => [event, process.listeners(event)]),
  );
  try {
    await runCli(argv, (text) => output.push(text), sources);
  } finally {
    for (const event of ["SIGINT", "SIGTERM"] as const)
      for (const listener of process.listeners(event))
        if (!original.get(event)?.includes(listener)) signals.push({ event, listener });
  }
  return output.join("");
}

function json(path: string, data: unknown) {
  writeFileSync(path, JSON.stringify(data));
}

describe("visible CLI configuration", () => {
  test("doctor identifies an overridden home file and gives allow-list meanings", async () => {
    const sources = workspace();
    json(sources.homeFile, { budgets: { global: { amount: "100" } } });
    json(sources.cwdFile, { budgets: { global: { amount: "500000000", maxPayments: 20 } } });
    const output = await cli(["doctor", "--db", sources.db], sources);
    expect(output).toContain(`${sources.cwdFile}  [exists, in use]`);
    expect(output).toContain(`${sources.homeFile}  [exists, overridden]`);
    expect(output).toContain("all hosts allowed");
    expect(output).toContain("all recipients allowed");
    expect(output).toContain("500000000  (500 USDC)");
    expect(output).toContain("max 20 payments");
    expect(output).toContain("HTTPS CONNECT: unmetered");
    expect(existsSync(sources.db)).toBe(false);
  });

  test("doctor JSON config exactly matches the loader used by the policy engine", async () => {
    const sources = workspace();
    const configFile = join(sources.root, "explicit.json");
    json(sources.homeFile, { policy: { maxSinglePayment: "1000" } });
    json(sources.cwdFile, { budgets: { perTask: { maxPayments: 200 } } });
    json(configFile, { ports: { dashboard: 9001 } });
    const expected = loadConfig({ db: sources.db }, { ...sources, configFile });
    const output = JSON.parse(
      await cli(["doctor", "--db", sources.db, "--config", configFile, "--json"], sources),
    );
    expect(output.config).toEqual(expected);
    expect(output.layers.map((layer: { name: string }) => layer.name)).toEqual([
      "flags",
      "environment",
      "explicit",
      "cwd",
      "home",
      "defaults",
    ]);
    expect(output).toMatchObject({
      configuration: "valid",
      sqlite: { status: "ready", events: 0 },
      networkChecks: "none",
    });
    expect(
      JSON.parse(
        await cli(
          ["config", "show", "--db", sources.db, "--config", configFile, "--json"],
          sources,
        ),
      ),
    ).toEqual(expected);
  });

  test("config commands show paths, save human units, and get atomic strings", async () => {
    const sources = workspace();
    const first = await cli(["config", "set", "budgets.global.amount", "200USDC"], sources);
    expect(first).toContain("100000000 → 200000000  (100 USDC → 200 USDC)");
    expect(first).toContain(`Written to ${sources.homeFile}`);
    expect(first).toContain("Restart taximeter for this to take effect.");
    expect(await cli(["config", "get", "budgets.global.amount"], sources)).toBe("200000000\n");
    expect(await cli(["config", "path"], sources)).toContain(
      `Default write target: ${sources.homeFile}`,
    );
    await cli(["config", "set", "budgets.global.amount", "200000000"], sources);
    expect(JSON.parse(readFileSync(sources.homeFile, "utf8")).budgets.global.amount).toBe(
      "200000000",
    );
    await cli(["config", "set", "policy.maxSinglePayment", "0.001USDC"], sources);
    expect(await cli(["config", "get", "policy.maxSinglePayment"], sources)).toBe("1000\n");
    expect(await cli(["config", "show"], sources)).toContain("Effective budgets:");
  });

  test("all subcommands accept common options on the group or on the subcommand", async () => {
    const sources = workspace();
    const path = join(sources.root, "chosen.json");
    json(path, { budgets: { perTask: { amount: "10" } } });
    expect(
      await cli(
        ["config", "--config", path, "get", "budgets.perTask.amount", "--db", sources.db],
        sources,
      ),
    ).toBe("10\n");
    for (const command of [
      ["path"],
      ["show"],
      ["get", "db"],
      ["set", "ports.proxy", "9000"],
      ["unset", "ports.proxy"],
    ])
      expect(
        await cli(["config", ...command, "--config", path, "--db", sources.db], sources),
      ).toBeTruthy();
    expect(existsSync(sources.db)).toBe(false);
  });

  test("arrays, nullable budgets, unset inheritance, and override warnings are explicit", async () => {
    const sources = workspace();
    json(sources.cwdFile, { policy: { maxSinglePayment: "1000000" } });
    await cli(["config", "set", "policy.allowHosts", "api.example.com,data.example.com"], sources);
    expect(await cli(["config", "get", "policy.allowHosts"], sources)).toBe(
      '["api.example.com","data.example.com"]\n',
    );
    await cli(["config", "set", "budgets.perTask", "null"], sources);
    expect(await cli(["config", "get", "budgets.perTask"], sources)).toBe("null\n");
    const unset = await cli(["config", "unset", "budgets.perTask"], sources);
    expect(unset).toContain("unset in file; effective:");
    expect(loadConfig({}, sources).budgets.perTask?.amount).toBe("5000000");
    const overridden = await cli(
      ["config", "set", "policy.maxSinglePayment", "2USDC", "--file", sources.homeFile],
      sources,
    );
    expect(overridden).toContain("written value is overridden");
    expect(loadConfig({}, sources).policy.maxSinglePayment).toBe("1000000");
    const external = join(sources.root, "other.json");
    expect(
      await cli(["config", "set", "ports.proxy", "9001", "--file", external], sources),
    ).toContain("not an active layer");
  });
});

describe("start overrides and actionable blocks", () => {
  test("the real CLI proxy applies a count flag, keeps files unchanged, and needs restart after a fix", async () => {
    const sources = workspace();
    const upstream = await fixtureUpstream();
    cleanup.push(() => upstream.close());
    json(sources.cwdFile, { budgets: { global: { amount: "100000000", maxPayments: 100 } } });
    const original = readFileSync(sources.cwdFile, "utf8");
    const startServices = lifecycle.startServices;
    const running: Awaited<ReturnType<typeof startServices>>[] = [];
    vi.spyOn(lifecycle, "startServices").mockImplementation(async (config) => {
      const service = await startServices(config);
      running.push(service);
      cleanup.push(() => service.close());
      return service;
    });
    const startArgs = [
      "start",
      "--db",
      sources.db,
      "--proxy-port",
      "0",
      "--dashboard-port",
      "0",
      "--upstream",
      upstream.url,
    ];
    const output = await cli([...startArgs, "--max-payments-global", "5"], sources);
    expect(output).toContain("Override: budgets.global.maxPayments = 5 (flags; not saved)");
    const service = running[0];
    if (!service) throw new Error("CLI did not start services");
    const request = async (nonce: number, proxyPort = service.proxyPort) => {
      const response = await fetch(`http://127.0.0.1:${proxyPort}/v2`, {
        headers: paymentHeader(2, nonce, `${upstream.url}/v2`),
      });
      return { status: response.status, body: await response.json() };
    };
    for (const nonce of [1, 2, 3, 4, 5]) expect((await request(nonce)).status).toBe(200);
    const blocked = await request(6);
    expect(blocked.status).toBe(402);
    expect(blockedBodySchema.parse(blocked.body)).toEqual({
      error: "blocked_by_taximeter",
      reason: "global_payment_count",
      budget: "5",
      spent: "5",
      remaining: "0",
      fix: "taximeter config set budgets.global.maxPayments 6",
    });
    expect((await request(1)).status).toBe(200);
    expect((await request(7)).body).toMatchObject({ spent: "5", reason: "global_payment_count" });
    expect(readFileSync(sources.cwdFile, "utf8")).toBe(original);
    expect(existsSync(sources.homeFile)).toBe(false);
    const fix = blockedBodySchema.parse(blocked.body).fix;
    if (!fix) throw new Error("Missing executable remedy");
    await cli(fix.split(" ").slice(1), sources);
    expect(loadConfig({}, sources).budgets.global?.maxPayments).toBe(6);
    expect((await request(6)).status).toBe(402);
    await service.close();
    await cli(startArgs, sources);
    const restarted = running[1];
    if (!restarted) throw new Error("CLI did not restart services");
    expect((await request(6, restarted.proxyPort)).status).toBe(200);
    expect((await request(8, restarted.proxyPort)).body).toMatchObject({ budget: "6", spent: "6" });
  });

  test("all one-run overrides use validated flag precedence and never change configuration files", async () => {
    const sources = workspace();
    json(sources.cwdFile, {
      budgets: { perTask: null },
      policy: { allowHosts: ["old.example.com"], denyHosts: ["old-deny.example.com"] },
    });
    const original = readFileSync(sources.cwdFile, "utf8");
    const startServices = lifecycle.startServices;
    const capture = vi.spyOn(lifecycle, "startServices").mockImplementation(async (config) => {
      const result = await startServices(config);
      cleanup.push(() => result.close());
      return result;
    });
    const output = await cli(
      [
        "start",
        "--db",
        sources.db,
        "--proxy-port",
        "0",
        "--dashboard-port",
        "0",
        "--budget-global",
        "200USDC",
        "--budget-task",
        "5 USDC",
        "--budget-agent",
        "50000000",
        "--max-payments-global",
        "5",
        "--max-payments-task",
        "2",
        "--max-payments-agent",
        "3",
        "--max-single",
        "0.001usdc",
        "--allow-host",
        "api.example.com",
        "--allow-host",
        "data.example.com",
        "--deny-host",
        "blocked.example.com",
      ],
      { ...sources, env: { TAXIMETER_PORT: "9000" } },
    );
    expect(capture.mock.calls[0]?.[0]).toMatchObject({
      budgets: {
        global: { amount: "200000000", maxPayments: 5 },
        perTask: { asset: "USDC", amount: "5000000", maxPayments: 2 },
        perAgent: { amount: "50000000", maxPayments: 3 },
      },
      policy: {
        maxSinglePayment: "1000",
        allowHosts: ["api.example.com", "data.example.com"],
        denyHosts: ["blocked.example.com"],
      },
      ports: { proxy: 0 },
    });
    expect(output.match(/^Override:/gm)).toHaveLength(12);
    expect(readFileSync(sources.cwdFile, "utf8")).toBe(original);
  });

  test.each(["0", "1.5", "1e3", "9007199254740992", "5USDC"])(
    "invalid count flag %j fails before any services or disk writes",
    async (value) => {
      const sources = workspace();
      const start = vi.spyOn(lifecycle, "startServices");
      await expect(
        cli(["start", "--db", sources.db, "--max-payments-global", value], sources),
      ).rejects.toThrow();
      expect(start).not.toHaveBeenCalled();
      expect(existsSync(sources.db)).toBe(false);
      expect(existsSync(sources.homeFile)).toBe(false);
    },
  );

  test("a bad amount unit flag is rejected before ledger initialization", async () => {
    const sources = workspace();
    await expect(
      cli(["start", "--db", sources.db, "--max-single", "1UNKNOWN"], sources),
    ).rejects.toThrow(/Known symbols: USDC/);
    expect(existsSync(sources.db)).toBe(false);
  });
});
