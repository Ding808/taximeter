import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { configValue, editConfig, schemaForKey } from "../src/config/edit";
import { loadConfig } from "../src/config/io";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, renameSync: vi.fn(actual.renameSync), openSync: vi.fn(actual.openSync) };
});

const prefix = join(tmpdir(), "taximeter-config-edit-");
const directories: string[] = [];
beforeEach(async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  vi.mocked(fs.renameSync).mockImplementation(actual.renameSync).mockClear();
  vi.mocked(fs.openSync).mockImplementation(actual.openSync).mockClear();
});
afterEach(() => {
  for (const path of directories.splice(0)) {
    if (!resolve(path).startsWith(resolve(prefix))) throw new Error("Unsafe cleanup path");
    fs.rmSync(path, { recursive: true, force: true });
  }
});

function workspace() {
  const root = fs.mkdtempSync(prefix);
  directories.push(root);
  const cwd = join(root, "project");
  const home = join(root, "home");
  fs.mkdirSync(cwd);
  fs.mkdirSync(home);
  return {
    root,
    cwd,
    home,
    env: {},
    cwdFile: join(cwd, "taximeter.config.json"),
    homeFile: join(home, ".taximeter", "config.json"),
  };
}

function write(path: string, value: unknown) {
  fs.mkdirSync(dirname(path), { recursive: true });
  fs.writeFileSync(path, JSON.stringify(value), { mode: 0o644 });
}

function stored(path: string) {
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

describe("configuration edits", () => {
  test.each(["200USDC", "200 USDC", "200usdc", "200000000"])(
    "stores %s as an exact atomic string and retrieves the same value",
    (value) => {
      const options = workspace();
      const result = editConfig({ key: "budgets.global.amount", value, options });
      expect(result.path).toBe(options.homeFile);
      expect(stored(options.homeFile)).toEqual({ budgets: { global: { amount: "200000000" } } });
      expect(configValue(loadConfig({}, options), "budgets.global.amount")).toBe("200000000");
    },
  );

  test("supports fractional single-payment amounts without affecting sibling policy", () => {
    const options = workspace();
    write(options.cwdFile, { policy: { denyHosts: ["blocked.test"] } });
    const result = editConfig({ key: "policy.maxSinglePayment", value: "0.001USDC", options });
    expect(result.path).toBe(options.cwdFile);
    expect(result.after.policy).toMatchObject({
      maxSinglePayment: "1000",
      denyHosts: ["blocked.test"],
    });
    expect(stored(options.cwdFile).policy.maxSinglePayment).toBe("1000");
  });

  test("unknown symbols create neither a file nor its parent directory", () => {
    const options = workspace();
    expect(() => editConfig({ key: "budgets.global.amount", value: "200DAI", options })).toThrow(
      "Known symbols: USDC",
    );
    expect(fs.existsSync(options.homeFile)).toBe(false);
    expect(fs.existsSync(dirname(options.homeFile))).toBe(false);
    expect(fs.renameSync).not.toHaveBeenCalled();
  });

  test("a misspelled key suggests the nearest schema key and preserves every original byte", () => {
    const options = workspace();
    const original = '{\n  "policy": { "unknownAsset": "deny" }\n}\n';
    fs.writeFileSync(options.cwdFile, original);
    expect(() => editConfig({ key: "budgets.globl.amount", value: "1USDC", options })).toThrow(
      'Did you mean "budgets.global.amount"?',
    );
    expect(fs.readFileSync(options.cwdFile, "utf8")).toBe(original);
    expect(fs.renameSync).not.toHaveBeenCalled();
  });

  test("schema paths reject prototype traversal and array indexes", () => {
    for (const key of [
      "__proto__.polluted",
      "policy.constructor",
      "policy.allowHosts.0",
      "budgets.global.missing",
    ]) {
      expect(() => schemaForKey(key)).toThrow("Unknown configuration key");
    }
    expect(schemaForKey("budgets.global.maxPayments")).toBeDefined();
  });

  test("a valid patch that is invalid over a lower null budget preserves the target", () => {
    const options = workspace();
    write(options.homeFile, { budgets: { global: null } });
    const original = '{\n  "policy": {"unknownAsset": "deny"}\n}\n';
    fs.writeFileSync(options.cwdFile, original);
    expect(() => editConfig({ key: "budgets.global.amount", value: "20", options })).toThrow(
      "budgets.global.asset",
    );
    expect(fs.readFileSync(options.cwdFile, "utf8")).toBe(original);
    expect(fs.renameSync).not.toHaveBeenCalled();
  });

  test.each([
    ["budgets.global.maxPayments", "2USDC"],
    ["budgets.global.maxPayments", "0"],
    ["budgets.global.maxPayments", "9007199254740992"],
    ["policy.maxSinglePayment", "01"],
    ["ports.proxy", "70000"],
    ["policy.allowHosts", "api.test,,data.test"],
    ["policy.allowHosts", "[malformed"],
  ])("invalid %s input reports the full key and leaves the file unchanged", (key, value) => {
    const options = workspace();
    write(options.cwdFile, { ports: { proxy: 9000 } });
    const original = fs.readFileSync(options.cwdFile);
    expect(() => editConfig({ key, value, options })).toThrow(key);
    expect(fs.readFileSync(options.cwdFile)).toEqual(original);
  });

  test("array input accepts comma-separated entries and explicit empty JSON arrays", () => {
    const options = workspace();
    editConfig({ key: "policy.allowHosts", value: "api.test, data.test", options });
    expect(stored(options.homeFile).policy.allowHosts).toEqual(["api.test", "data.test"]);
    editConfig({ key: "policy.allowHosts", value: "[]", options });
    expect(stored(options.homeFile).policy.allowHosts).toEqual([]);
    editConfig({ key: "policy.allowHosts", value: "", options });
    expect(stored(options.homeFile).policy.allowHosts).toEqual([]);
  });

  test("nullable fields can be disabled and numeric limits remain plain numbers", () => {
    const options = workspace();
    editConfig({ key: "budgets.perTask", value: "null", options });
    editConfig({ key: "budgets.global.maxPayments", value: "20", options });
    editConfig({ key: "policy.maxSinglePayment", value: "null", options });
    expect(stored(options.homeFile)).toMatchObject({
      budgets: { perTask: null, global: { maxPayments: 20 } },
      policy: { maxSinglePayment: null },
    });
  });

  test("defaults to an existing cwd file, otherwise home, while --config only controls reading", () => {
    const options = workspace();
    const explicit = join(options.root, "explicit.json");
    write(explicit, { budgets: { global: { amount: "900" } } });
    const first = editConfig({
      key: "budgets.global.amount",
      value: "100",
      options: { ...options, configFile: explicit },
    });
    expect(first.path).toBe(options.homeFile);
    expect(first.after.budgets.global?.amount).toBe("900");
    expect(stored(explicit).budgets.global.amount).toBe("900");
    write(options.cwdFile, {});
    const second = editConfig({
      key: "budgets.global.amount",
      value: "200",
      options: { ...options, configFile: explicit },
    });
    expect(second.path).toBe(options.cwdFile);
    expect(stored(options.homeFile).budgets.global.amount).toBe("100");
  });

  test("--file chooses a separate output without making it an effective config layer", () => {
    const options = workspace();
    const file = join(options.root, "standalone", "config.json");
    const result = editConfig({ key: "budgets.global.maxPayments", value: "5", file, options });
    expect(result.participates).toBe(false);
    expect(result.writtenValue).toBe(5);
    expect(result.after.budgets.global?.maxPayments).toBeUndefined();
    expect(stored(file)).toEqual({ budgets: { global: { maxPayments: 5 } } });
    expect(fs.existsSync(options.homeFile)).toBe(false);
  });

  test("a lower layer's human amount uses its own asset instead of a higher override", () => {
    const options = workspace();
    write(options.homeFile, { budgets: { global: { asset: "DAI", amount: "10" } } });
    write(options.cwdFile, { budgets: { global: { asset: "USDC" } } });
    const original = fs.readFileSync(options.homeFile);
    expect(() =>
      editConfig({ key: "budgets.global.amount", value: "5USDC", file: options.homeFile, options }),
    ).toThrow("does not match configured asset DAI");
    expect(fs.readFileSync(options.homeFile)).toEqual(original);
    editConfig({ key: "budgets.global.amount", value: "500", file: options.homeFile, options });
    expect(stored(options.homeFile).budgets.global.amount).toBe("500");
  });

  test("an inherited lower asset and standalone asset cannot be silently reinterpreted", () => {
    const options = workspace();
    write(options.homeFile, { budgets: { global: { asset: "DAI" } } });
    write(options.cwdFile, {});
    const explicit = join(options.root, "explicit.json");
    write(explicit, { budgets: { global: { asset: "USDC" } } });
    expect(() =>
      editConfig({
        key: "budgets.global.amount",
        value: "5USDC",
        options: { ...options, configFile: explicit },
      }),
    ).toThrow("does not match configured asset DAI");
    const standalone = join(options.root, "standalone.json");
    write(standalone, { policy: { maxSingleAsset: "DAI" } });
    expect(() =>
      editConfig({ key: "policy.maxSinglePayment", value: "5USDC", file: standalone, options }),
    ).toThrow("does not match configured asset DAI");
  });

  test("unset removes empty ancestors and exposes the lower value", () => {
    const options = workspace();
    write(options.homeFile, { budgets: { global: { amount: "100" } } });
    write(options.cwdFile, { budgets: { global: { amount: "200" } }, ports: { proxy: 9000 } });
    const result = editConfig({ key: "budgets.global.amount", unset: true, options });
    expect(result.before.budgets.global?.amount).toBe("200");
    expect(result.after.budgets.global?.amount).toBe("100");
    expect(result.writtenValue).toBeUndefined();
    expect(stored(options.cwdFile)).toEqual({ ports: { proxy: 9000 } });
  });

  test("unset on a missing file creates nothing", () => {
    const options = workspace();
    const result = editConfig({ key: "policy.allowHosts", unset: true, options });
    expect(result.changed).toBe(false);
    expect(fs.existsSync(dirname(options.homeFile))).toBe(false);
    expect(fs.renameSync).not.toHaveBeenCalled();
  });
});

describe("atomic configuration writes", () => {
  test("publishes a complete same-directory temporary file without truncating the target", async () => {
    const options = workspace();
    write(options.cwdFile, { budgets: { global: { amount: "100" } } });
    const original = fs.readFileSync(options.cwdFile);
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    let observed = false;
    vi.mocked(fs.renameSync).mockImplementationOnce((source, destination) => {
      expect(dirname(String(source))).toBe(dirname(options.cwdFile));
      expect(destination).toBe(options.cwdFile);
      expect(fs.readFileSync(options.cwdFile)).toEqual(original);
      expect(stored(String(source))).toEqual({ budgets: { global: { amount: "200000000" } } });
      expect(
        vi
          .mocked(fs.openSync)
          .mock.calls.some(
            ([path, flags, mode]) => path === source && flags === "wx" && mode === 0o600,
          ),
      ).toBe(true);
      if (process.platform !== "win32") expect(fs.statSync(source).mode & 0o777).toBe(0o600);
      actual.renameSync(source, destination);
      expect(stored(options.cwdFile).budgets.global.amount).toBe("200000000");
      observed = true;
    });
    editConfig({ key: "budgets.global.amount", value: "200USDC", options });
    expect(observed).toBe(true);
    expect(fs.readdirSync(options.cwd)).toEqual(["taximeter.config.json"]);
    if (process.platform !== "win32") expect(fs.statSync(options.cwdFile).mode & 0o777).toBe(0o600);
  });

  test("rename failure preserves the original and removes its temporary file", () => {
    const options = workspace();
    write(options.cwdFile, { budgets: { global: { amount: "100" } } });
    const original = fs.readFileSync(options.cwdFile);
    vi.mocked(fs.renameSync).mockImplementationOnce(() => {
      throw new Error("simulated rename failure");
    });
    expect(() => editConfig({ key: "budgets.global.amount", value: "200USDC", options })).toThrow(
      "simulated rename failure",
    );
    expect(fs.readFileSync(options.cwdFile)).toEqual(original);
    expect(fs.readdirSync(options.cwd)).toEqual(["taximeter.config.json"]);
  });
});
