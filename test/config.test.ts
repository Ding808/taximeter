import { describe, expect, test } from "vitest";
import { parseConfig } from "../src/config";
import { amountSchema, blockedBodySchema, httpUrlSchema } from "../src/model";
import { payloadV1Schema, payloadV2Schema } from "../src/rails/schemas";

describe("external input contracts", () => {
  test("zero configuration has documented defaults", () => {
    expect(parseConfig()).toMatchObject({
      ports: { proxy: 8402, dashboard: 8403 },
      db: "~/.taximeter/ledger.db",
      budgets: { global: { amount: "100000000" } },
    });
  });
  test("later layers win while sibling fields remain", () => {
    expect(
      parseConfig(
        { budgets: { global: { amount: "10" } }, ports: { proxy: 9000 } },
        { budgets: { global: { amount: "20" } } },
      ),
    ).toMatchObject({
      budgets: { global: { amount: "20", asset: "USDC", window: "24h" } },
      ports: { proxy: 9000, dashboard: 8403 },
    });
    expect(
      parseConfig({ budgets: { perTask: null }, policy: { maxSinglePayment: null } }).budgets
        .perTask,
    ).toBeNull();
  });
  test.each([1, 1.5, "1.0", "1e6", "-1", "NaN", "01", "", "1".repeat(79)])(
    "rejects noncanonical money %j",
    (amount) => {
      expect(amountSchema.safeParse(amount).success).toBe(false);
      expect(() => parseConfig({ budgets: { global: { amount } } })).toThrow();
    },
  );
  test("keeps values beyond Number precision as strings", () => {
    expect(amountSchema.parse("900719925474099300000001")).toBe("900719925474099300000001");
  });
  test("partial policy and port layers never reapply defaults over explicit settings", () => {
    const config = parseConfig(
      { policy: { maxSinglePayment: "20", denyHosts: ["deny.test"] }, ports: { proxy: 9100 } },
      { policy: { allowHosts: ["allow.test"] }, ports: { dashboard: 9200 } },
    );
    expect(config.policy.maxSinglePayment).toBe("20");
    expect(config.policy.denyHosts).toEqual(["deny.test"]);
    expect(config.ports).toEqual({ proxy: 9100, dashboard: 9200 });
  });
  test.each([
    { privateKey: "secret" },
    { ports: { proxy: -1 } },
    { budgets: { global: { window: "forever" } } },
    { policy: { misspelled: [] } },
  ])("rejects invalid config %j", (input) => expect(() => parseConfig(input)).toThrow());
  test("URL validation rejects non-HTTP targets and credentials", () => {
    expect(httpUrlSchema.safeParse("file:///etc/passwd").success).toBe(false);
    expect(httpUrlSchema.safeParse("http://user:pass@localhost").success).toBe(false);
  });
  test("wire schemas refuse invented generic replay shapes", () => {
    expect(payloadV1Schema.safeParse({ x402Version: 1, amount: "10" }).success).toBe(false);
    expect(payloadV2Schema.safeParse({ x402Version: 2, accepts: [] }).success).toBe(false);
    expect(blockedBodySchema.safeParse({ error: "blocked_by_taximeter" }).success).toBe(false);
  });
});
