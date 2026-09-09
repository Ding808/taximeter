import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { parseConfig } from "../src/config";
import { formatAmount, knownAmountSymbols, parseAmountInput } from "../src/config/amount-input";
import { formatEffectiveConfig, formatLayers } from "../src/config/display";
import { loadConfig, loadConfigDetails } from "../src/config/io";

const tempPrefix = join(tmpdir(), "taximeter-config-visibility-");
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    if (!resolve(directory).startsWith(resolve(tempPrefix))) throw new Error("Unsafe cleanup path");
    rmSync(directory, { recursive: true, force: true });
  }
});

function workspace() {
  const root = mkdtempSync(tempPrefix);
  directories.push(root);
  const cwd = join(root, "project");
  const home = join(root, "home");
  mkdirSync(cwd);
  mkdirSync(join(home, ".taximeter"), { recursive: true });
  return {
    cwd,
    home,
    env: {},
    homeFile: join(home, ".taximeter", "config.json"),
    cwdFile: join(cwd, "taximeter.config.json"),
  };
}

function write(path: string, value: unknown) {
  writeFileSync(path, JSON.stringify(value), "utf8");
}

describe("visible configuration", () => {
  test("lists all six layers highest first and marks fully overridden home values", () => {
    const sources = workspace();
    write(sources.homeFile, { budgets: { global: { amount: "10" } } });
    write(sources.cwdFile, { budgets: { global: { amount: "20" } } });
    const details = loadConfigDetails({}, sources);
    expect(details.layers.map((layer) => layer.name)).toEqual([
      "flags",
      "environment",
      "explicit",
      "cwd",
      "home",
      "defaults",
    ]);
    expect(details.layers.find((layer) => layer.name === "cwd")).toMatchObject({
      exists: true,
      contributed: true,
      contributedKeys: ["budgets.global.amount"],
    });
    expect(details.layers.find((layer) => layer.name === "home")).toMatchObject({
      exists: true,
      contributed: false,
      overriddenKeys: ["budgets.global.amount"],
    });
    const text = formatLayers(details);
    expect(text).toContain(`${sources.cwdFile}  [exists, in use]`);
    expect(text).toContain(`${sources.homeFile}  [exists, overridden]`);
    expect(details.defaultWritePath).toBe(sources.cwdFile);
    expect(JSON.parse(JSON.stringify(details.config))).toEqual(loadConfig({}, sources));
  });

  test("partially overridden files retain ownership of surviving sibling keys", () => {
    const sources = workspace();
    write(sources.homeFile, { ports: { proxy: 9001, dashboard: 9002 } });
    write(sources.cwdFile, { ports: { proxy: 9011 } });
    const details = loadConfigDetails({}, sources);
    expect(details.config.ports).toEqual({ proxy: 9011, dashboard: 9002 });
    expect(details.layers.find((layer) => layer.name === "home")).toMatchObject({
      contributed: true,
      contributedKeys: ["ports.dashboard"],
      overriddenKeys: ["ports.proxy"],
    });
    expect(formatLayers(details)).toContain("[exists, in use; overridden keys: ports.proxy]");
  });

  test("attributes flag, environment, and explicit overrides to the keys they actually supply", () => {
    const sources = workspace();
    const explicit = join(sources.cwd, "explicit.json");
    write(explicit, {
      ports: { proxy: 1111, dashboard: 2222 },
      policy: { allowHosts: ["api.test"] },
    });
    const details = loadConfigDetails(
      { ports: { proxy: 4444 } },
      {
        ...sources,
        configFile: explicit,
        env: { TAXIMETER_DB: "injected.db", TAXIMETER_PORT: "3333", UNRELATED: "ignored" },
      },
    );
    expect(details.config.ports).toEqual({ proxy: 4444, dashboard: 2222 });
    expect(details.layers.find((layer) => layer.name === "environment")).toMatchObject({
      environmentVariables: ["TAXIMETER_DB", "TAXIMETER_PORT"],
      contributedKeys: ["db"],
      overriddenKeys: ["ports.proxy"],
    });
    expect(details.layers.find((layer) => layer.name === "explicit")?.contributedKeys).toEqual([
      "policy.allowHosts",
      "ports.dashboard",
    ]);
    expect(details.layers[0]?.contributedKeys).toEqual(["ports.proxy"]);
  });

  test("null disables a whole budget and overrides all lower budget leaves", () => {
    const sources = workspace();
    write(sources.homeFile, { budgets: { global: { amount: "10", window: "1h" } } });
    const details = loadConfigDetails({ budgets: { global: null } }, sources);
    expect(details.config.budgets.global).toBeNull();
    expect(details.layers.find((layer) => layer.name === "home")?.contributed).toBe(false);
    expect(details.layers[0]?.contributedKeys).toEqual(["budgets.global"]);
  });

  test("missing layers and default target are reported without creating directories or files", () => {
    const sources = workspace();
    const absentHome = join(sources.home, "absent");
    const details = loadConfigDetails({}, { ...sources, home: absentHome });
    expect(details.defaultWritePath).toBe(join(absentHome, ".taximeter", "config.json"));
    expect(details.layers.find((layer) => layer.name === "explicit")).toMatchObject({
      exists: false,
      supplied: false,
      contributed: false,
    });
    expect(formatLayers(details)).toContain("(not supplied)");
    expect(formatLayers(details)).toContain("[not found]");
    expect(existsSync(absentHome)).toBe(false);
    expect(existsSync(sources.cwdFile)).toBe(false);
  });

  test("candidate file overrides validate a full merge without changing disk", () => {
    const sources = workspace();
    write(sources.homeFile, { budgets: { global: { amount: "100" } } });
    write(sources.cwdFile, { budgets: { global: { window: "1h" } } });
    const before = readFileSync(sources.cwdFile);
    const details = loadConfigDetails(
      {},
      {
        ...sources,
        layerOverrides: { [sources.cwdFile]: { budgets: { global: { amount: "200" } } } },
      },
    );
    expect(details.config.budgets.global).toMatchObject({
      amount: "200",
      asset: "USDC",
      window: "24h",
    });
    expect(readFileSync(sources.cwdFile)).toEqual(before);
    expect(() =>
      loadConfigDetails(
        {},
        {
          ...sources,
          layerOverrides: { [sources.cwdFile]: { policy: { unknownAsset: "unsafe" } } },
        },
      ),
    ).toThrow();
    expect(readFileSync(sources.cwdFile)).toEqual(before);
  });

  test("an absent explicit file is accepted only when a candidate is provided for that exact path", () => {
    const sources = workspace();
    const path = join(sources.cwd, "new.json");
    expect(() => loadConfigDetails({}, { ...sources, configFile: path })).toThrow("not found");
    const details = loadConfigDetails(
      {},
      {
        ...sources,
        configFile: path,
        layerOverrides: { [path]: { policy: { maxSinglePayment: "1000" } } },
      },
    );
    expect(details.config.policy.maxSinglePayment).toBe("1000");
    expect(details.layers.find((layer) => layer.name === "explicit")).toMatchObject({
      exists: false,
      supplied: true,
      contributed: true,
    });
    expect(existsSync(path)).toBe(false);
  });

  test("canonical file paths let candidate validation follow linked configuration directories", () => {
    const sources = workspace();
    const alias = join(sources.cwd, "linked-config");
    symlinkSync(
      join(sources.home, ".taximeter"),
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    write(sources.homeFile, { policy: { maxSinglePayment: "10" } });
    const details = loadConfigDetails(
      {},
      {
        ...sources,
        configFile: join(alias, "config.json"),
        layerOverrides: { [sources.homeFile]: { policy: { maxSinglePayment: "20" } } },
      },
    );
    expect(details.config.policy.maxSinglePayment).toBe("20");
    expect(details.layers.find((layer) => layer.name === "explicit")?.path).toBe(sources.homeFile);
    expect(JSON.parse(readFileSync(sources.homeFile, "utf8"))).toEqual({
      policy: { maxSinglePayment: "10" },
    });
    expect(
      loadConfigDetails({}, { ...sources, configFile: "~/.taximeter/config.json" }).config.policy
        .maxSinglePayment,
    ).toBe("10");
  });

  test("invalid configuration identifies the failed path", () => {
    const sources = workspace();
    write(sources.cwdFile, { budgets: { global: { amount: "1.5" } } });
    expect(() => loadConfigDetails({}, sources)).toThrow("budgets.global.amount");
  });

  test("effective display explains empty allow lists, amounts, count-only limits, and unknown assets", () => {
    const config = parseConfig(
      {
        policy: { maxSinglePayment: "500000" },
        budgets: { perTask: null, global: { asset: "0xunknown", amount: "7", maxPayments: 20 } },
      },
      { budgets: { perTask: { asset: "USDC", maxPayments: 5, network: "eip155:84532" } } },
    );
    const text = formatEffectiveConfig(config);
    expect(text).toContain("500000  (0.5 USDC)");
    expect(text).toContain("(empty — all hosts allowed)");
    expect(text).toContain("(empty — all recipients allowed)");
    expect(text).toContain("(no amount limit)  max 5 payments  asset USDC  network eip155:84532");
    expect(text).toContain("7 atomic units  24h  max 20 payments");
  });
});

describe("exact human amount input", () => {
  test.each([
    ["5USDC", "5000000"],
    ["5 USDC", "5000000"],
    ["5usdc", "5000000"],
    ["0.001USDC", "1000"],
    ["5000000", "5000000"],
    ["0USDC", "0"],
    ["9007199254740993.000001USDC", "9007199254740993000001"],
    ["9007199254740993000001", "9007199254740993000001"],
  ])("%s preserves exact integer precision", (input, expected) => {
    expect(parseAmountInput(input)).toBe(expected);
  });

  test("known contract selectors use the registry and unknown selectors remain atomic", () => {
    const base = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
    expect(parseAmountInput("2USDC", base, "eip155:8453")).toBe("2000000");
    expect(formatAmount("2000000", base, "eip155:8453")).toBe("2 USDC");
    expect(formatAmount("2000000", base)).toBe("2 USDC");
    expect(formatAmount("2000000", base, "eip155:1")).toBe("2000000 atomic units");
    expect(parseAmountInput("7", "UNKNOWN")).toBe("7");
    expect(() => parseAmountInput("2USDC", "UNKNOWN")).toThrow("does not match configured asset");
    expect(() => parseAmountInput("2USDC", base, "eip155:1")).toThrow(
      "does not match configured asset",
    );
  });

  test("unknown symbols report the known registry symbols and atomic alternative", () => {
    expect(knownAmountSymbols()).toEqual(["USDC"]);
    expect(() => parseAmountInput("5DAI")).toThrow(
      "Known symbols: USDC. An exact atomic integer is always accepted.",
    );
  });

  test.each([
    "1.0000001USDC",
    "0.1",
    "1e6",
    "-1USDC",
    "+1USDC",
    "01USDC",
    "01",
    "NaN",
    "Infinity",
    "1,000USDC",
    "",
  ])("rejects ambiguous or inexact input %j", (input) =>
    expect(() => parseAmountInput(input)).toThrow(),
  );

  test("formats without rounding or converting through Number", () => {
    expect(formatAmount("1", "USDC")).toBe("0.000001 USDC");
    expect(formatAmount("0", "USDC")).toBe("0 USDC");
    expect(formatAmount("9007199254740993000001", "USDC")).toBe("9007199254740993.000001 USDC");
    expect(formatAmount("7", "UNKNOWN")).toBe("7 atomic units");
  });
});
