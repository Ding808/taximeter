import { describe, expect, test } from "vitest";
import { parseConfig } from "../src/config";
import { evaluate, spentForBudget } from "../src/policy/index";
import { event } from "./helpers";

const now = Date.parse("2026-09-08T12:00:00.000Z");
describe("policy (tests written before implementation)", () => {
  test("default policy allows a small recognized payment", () => {
    expect(evaluate(event(), [], parseConfig(), now)).toEqual({ allowed: true });
  });
  test.each([
    {
      asset: "0x0000000000000000000000000000000000000001",
      assetSymbol: undefined,
      decimals: 0,
      decimalsKnown: false,
    },
    {
      asset: "0x0000000000000000000000000000000000000001",
      assetSymbol: "USDC",
      decimals: 6,
      decimalsKnown: true,
    },
    { network: "eip155:1", assetSymbol: "USDC", decimalsKnown: true },
  ])("unknown assets are denied by offline identity despite supplied metadata %j", (patch) => {
    expect(evaluate(event(patch), [], parseConfig(), now)).toEqual({
      allowed: false,
      body: {
        error: "blocked_by_taximeter",
        reason: "unknown_asset",
        budget: null,
        spent: "0",
        remaining: null,
      },
    });
  });
  test.each([
    ["eip155:8453", "0x833589FCD6EDB6E08F4C7C32D4F71B54BDA02913"],
    ["eip155:84532", "0x036CBD53842C5426634E7929541EC2318F3DCF7E"],
  ])("known asset identity is sufficient without event metadata on %s", (network, asset) => {
    expect(
      evaluate(
        event({ network, asset, assetSymbol: undefined, decimals: 0, decimalsKnown: false }),
        [],
        parseConfig(),
        now,
      ),
    ).toEqual({ allowed: true });
  });
  test("custom token budgets require explicit allow and then enforce exact contract totals", () => {
    const proposed = event({ asset: "0x0000000000000000000000000000000000000001" });
    const config = parseConfig({
      budgets: { global: { amount: "7", asset: proposed.asset, network: proposed.network } },
    });
    expect(evaluate(proposed, [], config, now)).toMatchObject({
      allowed: false,
      body: { reason: "unknown_asset" },
    });
    const allowed = parseConfig(config, { policy: { unknownAsset: "allow" } });
    expect(evaluate(proposed, [], allowed, now)).toEqual({ allowed: true });
    expect(evaluate(proposed, [event({ asset: proposed.asset })], allowed, now)).toMatchObject({
      allowed: false,
      body: { reason: "global_budget", budget: "7", spent: "7", remaining: "0" },
    });
  });
  test("budget permits exactly twenty payments and describes the twenty-first rejection", () => {
    const config = parseConfig({ budgets: { global: { amount: "140" } } });
    const log = Array.from({ length: 20 }, () => event());
    expect(evaluate(event(), log.slice(0, 19), config, now)).toEqual({ allowed: true });
    expect(evaluate(event(), log, config, now)).toEqual({
      allowed: false,
      body: {
        error: "blocked_by_taximeter",
        reason: "global_budget",
        budget: "140",
        spent: "140",
        remaining: "0",
      },
    });
  });
  test("large budgets use exact arithmetic above Number precision", () => {
    const config = parseConfig({
      policy: { maxSinglePayment: null },
      budgets: { perTask: null, perAgent: null, global: { amount: "900719925474099300000001" } },
    });
    const log = [event({ amount: "900719925474099300000000" })];
    expect(evaluate(event({ amount: "1" }), log, config, now).allowed).toBe(true);
    expect(evaluate(event({ amount: "2" }), log, config, now)).toMatchObject({
      allowed: false,
      body: { remaining: "1" },
    });
  });
  test.each([
    [{ denyHosts: ["API.EXAMPLE.TEST"] }, "host_denied"],
    [{ allowHosts: ["elsewhere.test"] }, "host_not_allowed"],
    [{ allowPayTo: ["0x0000000000000000000000000000000000000000"] }, "recipient_not_allowed"],
    [{ maxSinglePayment: "6" }, "max_single_payment"],
  ])("enforces host, recipient and per-payment rules %j", (policy, reason) => {
    expect(evaluate(event(), [], parseConfig({ policy }), now)).toMatchObject({
      allowed: false,
      body: { reason },
    });
  });
  test("allow rules compare normalized exact host and recipient identities", () => {
    const proposed = event();
    expect(
      evaluate(
        proposed,
        [],
        parseConfig({
          policy: {
            allowHosts: [proposed.host.toUpperCase()],
            allowPayTo: [proposed.payTo.toUpperCase()],
          },
        }),
        now,
      ).allowed,
    ).toBe(true);
    expect(
      evaluate(
        event({ host: "api.example.test.evil.test" }),
        [],
        parseConfig({ policy: { allowHosts: [proposed.host] } }),
        now,
      ).allowed,
    ).toBe(false);
  });
  test("deny wins over allow", () => {
    const host = event().host;
    expect(
      evaluate(
        event(),
        [],
        parseConfig({ policy: { allowHosts: [host], denyHosts: [host] } }),
        now,
      ),
    ).toMatchObject({ body: { reason: "host_denied", budget: null, remaining: null } });
  });
  test.each(["perTask", "perAgent"] as const)(
    "enforces the %s attribution bucket independently",
    (scope) => {
      const config = parseConfig({ budgets: { [scope]: { amount: "7" } } });
      expect(evaluate(event(), [event()], config, now).allowed).toBe(false);
      expect(
        evaluate(
          event(scope === "perTask" ? { taskId: "task-b" } : { agentId: "agent-b" }),
          [event()],
          config,
          now,
        ).allowed,
      ).toBe(true);
    },
  );
  test("unattributed payments share an explicit budget bucket", () => {
    const config = parseConfig({ budgets: { perTask: { amount: "7" } } });
    expect(
      evaluate(event({ taskId: undefined }), [event({ taskId: undefined })], config, now).allowed,
    ).toBe(false);
  });
  test("window is inclusive at start, excludes old and future events", () => {
    const config = parseConfig({ budgets: { global: { amount: "7", window: "24h" } } });
    expect(
      evaluate(event(), [event({ ts: "2026-09-07T12:00:00.000Z" })], config, now).allowed,
    ).toBe(false);
    expect(
      evaluate(
        event(),
        [event({ ts: "2026-09-07T11:59:59.999Z" }), event({ ts: "2026-09-08T12:00:00.001Z" })],
        config,
        now,
      ).allowed,
    ).toBe(true);
  });
  test.each(["1h", "7d", "30d"] as const)("supports documented window %s", (window) => {
    expect(
      spentForBudget(event(), [event()], { amount: "7", asset: "USDC", window }, "global", now),
    ).toBe("7");
  });
  test("duplicates, blocked and failed rows never inflate spent", () => {
    const original = event();
    const log = [
      original,
      original,
      event({ status: "blocked" }),
      event({ settlementStatus: "failed" }),
    ];
    expect(spentForBudget(event(), log, { amount: "7", asset: "USDC" }, "global", now)).toBe("7");
    expect(
      evaluate(original, log, parseConfig({ budgets: { global: { amount: "7" } } }), now).allowed,
    ).toBe(true);
  });
  test("failed authorization retry is charged again when it is forwarded", () => {
    const prior = event({ settlementStatus: "failed" });
    expect(
      evaluate(prior, [prior, event()], parseConfig({ budgets: { global: { amount: "7" } } }), now)
        .allowed,
    ).toBe(false);
  });
  test("never mixes networks or asset contracts", () => {
    const config = parseConfig({ budgets: { global: { amount: "7" } } });
    expect(
      evaluate(
        event(),
        [
          event({ network: "eip155:84532" }),
          event({ asset: "0x0000000000000000000000000000000000000001" }),
        ],
        config,
        now,
      ).allowed,
    ).toBe(true);
    expect(
      evaluate(
        event(),
        [event()],
        parseConfig({ budgets: { global: { amount: "0", network: "eip155:84532" } } }),
        now,
      ).allowed,
    ).toBe(true);
  });
  test("explicitly allowed unknown tokens cannot forge a USDC ticker to acquire its budget or scale", () => {
    const other = event({
      asset: "0x0000000000000000000000000000000000000001",
      amount: "9999999999",
    });
    expect(
      evaluate(other, [], parseConfig({ policy: { unknownAsset: "allow" } }), now).allowed,
    ).toBe(true);
    expect(
      evaluate(
        other,
        [],
        parseConfig({
          policy: { unknownAsset: "allow", maxSingleAsset: other.asset, maxSinglePayment: "1" },
        }),
        now,
      ).allowed,
    ).toBe(false);
  });
  test("null budgets disable individual scopes and remaining is clamped to zero", () => {
    expect(
      evaluate(
        event(),
        [event()],
        parseConfig({ budgets: { perTask: null, perAgent: null, global: null } }),
        now,
      ).allowed,
    ).toBe(true);
    expect(
      evaluate(
        event(),
        [event({ amount: "20" })],
        parseConfig({ budgets: { global: { amount: "10" } } }),
        now,
      ),
    ).toMatchObject({ body: { spent: "20", remaining: "0" } });
  });
});
