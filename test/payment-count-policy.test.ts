import { describe, expect, test } from "vitest";
import { budgetSchema, configPatchSchema, configSchema, parseConfig } from "../src/config";
import { blockedBodySchema } from "../src/model";
import {
  countForBudget,
  evaluate,
  evaluateWithState,
  type PolicyState,
  type Scope,
  totalsForBudget,
} from "../src/policy";
import { event } from "./helpers";

const now = Date.parse("2026-09-08T12:00:00.000Z");
const scopes = ["perTask", "perAgent", "global"] as const;
const reasons = {
  perTask: "per_task_payment_count",
  perAgent: "per_agent_payment_count",
  global: "global_payment_count",
};
const base = { budgets: { perTask: null, perAgent: null, global: null } };

describe("payment-count input contracts", () => {
  test("full budgets accept either kind of limit and require at least one", () => {
    expect(budgetSchema.parse({ asset: "USDC", maxPayments: 20 })).toEqual({
      asset: "USDC",
      maxPayments: 20,
    });
    expect(budgetSchema.parse({ asset: "USDC", amount: "0" })).toEqual({
      asset: "USDC",
      amount: "0",
    });
    expect(budgetSchema.safeParse({ asset: "USDC" }).success).toBe(false);
    expect(
      configSchema.parse({ budgets: { global: { asset: "USDC", maxPayments: 20 } } }).budgets
        .global,
    ).toEqual({ asset: "USDC", maxPayments: 20 });
    expect(
      parseConfig(base, { budgets: { global: { asset: "USDC", maxPayments: 20 } } }).budgets.global,
    ).toEqual({ asset: "USDC", maxPayments: 20 });
    expect(() => parseConfig(base, { budgets: { global: { asset: "USDC" } } })).toThrow(
      "A budget must set amount or maxPayments",
    );
  });

  test("partial layers may change metadata alone but still validate the merged budget", () => {
    expect(configPatchSchema.parse({ budgets: { global: { window: "1h" } } })).toEqual({
      budgets: { global: { window: "1h" } },
    });
    expect(
      parseConfig(
        { budgets: { global: { maxPayments: 20 } } },
        { budgets: { global: { window: "1h" } } },
      ).budgets.global,
    ).toEqual({ asset: "USDC", amount: "100000000", maxPayments: 20, window: "1h" });
    expect(() => parseConfig(base, { budgets: { global: { amount: "1" } } })).toThrowError(
      expect.objectContaining({
        issues: expect.arrayContaining([
          expect.objectContaining({ path: ["budgets", "global", "asset"] }),
        ]),
      }),
    );
  });

  test.each([0, -1, 1.5, "20", null, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN])(
    "rejects an invalid payment count %s",
    (maxPayments) => {
      expect(budgetSchema.safeParse({ asset: "USDC", maxPayments }).success).toBe(false);
      expect(() => parseConfig({ budgets: { global: { maxPayments } } })).toThrow();
    },
  );

  test("the largest safe integer is exact and the fix field remains backwards compatible", () => {
    expect(
      budgetSchema.parse({ asset: "USDC", maxPayments: Number.MAX_SAFE_INTEGER }),
    ).toMatchObject({ maxPayments: Number.MAX_SAFE_INTEGER });
    const body = {
      error: "blocked_by_taximeter",
      reason: "global_payment_count",
      budget: "20",
      spent: "20",
      remaining: "0",
    };
    expect(blockedBodySchema.parse(body)).toEqual(body);
    expect(
      blockedBodySchema.parse({
        ...body,
        fix: "taximeter config set budgets.global.maxPayments 21",
      }),
    ).toMatchObject({ fix: "taximeter config set budgets.global.maxPayments 21" });
    expect(blockedBodySchema.safeParse({ ...body, fix: 21 }).success).toBe(false);
  });
});

describe("pure payment-count policy", () => {
  test("twenty cheap payments fit a large amount budget and the twenty-first hits the count", () => {
    const config = parseConfig({ budgets: { global: { amount: "100000000", maxPayments: 20 } } });
    const log = Array.from({ length: 20 }, () => event());
    expect(evaluate(event(), log.slice(0, 19), config, now)).toEqual({ allowed: true });
    expect(evaluate(event(), log, config, now)).toEqual({
      allowed: false,
      body: {
        error: "blocked_by_taximeter",
        reason: "global_payment_count",
        budget: "20",
        spent: "20",
        remaining: "0",
        fix: "taximeter config set budgets.global.maxPayments 21",
      },
    });
  });

  test("zero-amount spend consumes count while blocked, failed and duplicate rows do not", () => {
    const original = event({ amount: "0" });
    const log = [
      original,
      original,
      event({ paymentKey: original.paymentKey }),
      event({ status: "blocked" }),
      event({ settlementStatus: "failed" }),
    ];
    const budget = { asset: "USDC", maxPayments: 1 };
    expect(totalsForBudget(event(), log, budget, "global", now)).toEqual({
      amount: "0",
      count: "1",
    });
    expect(
      evaluate(event(), log, parseConfig(base, { budgets: { global: budget } }), now),
    ).toMatchObject({ allowed: false, body: { reason: "global_payment_count", spent: "1" } });
  });

  test.each(scopes)("count-only %s budgets share amount attribution rules", (scope) => {
    const config = parseConfig(base, { budgets: { [scope]: { asset: "USDC", maxPayments: 1 } } });
    expect(evaluate(event(), [event()], config, now)).toMatchObject({
      allowed: false,
      body: { reason: reasons[scope] },
    });
    if (scope !== "global") {
      const attribution = scope === "perTask" ? { taskId: "other" } : { agentId: "other" };
      expect(evaluate(event(attribution), [event()], config, now)).toEqual({ allowed: true });
      const missing = scope === "perTask" ? { taskId: undefined } : { agentId: undefined };
      expect(evaluate(event(missing), [event(missing)], config, now).allowed).toBe(false);
    }
  });

  test("each scope checks amount before count, and its count before the next scope's amount", () => {
    const config = parseConfig({
      budgets: {
        perTask: { amount: "7", maxPayments: 1 },
        perAgent: { amount: "7", maxPayments: 1 },
        global: { amount: "7", maxPayments: 1 },
      },
    });
    expect(evaluate(event(), [event()], config, now)).toMatchObject({
      body: { reason: "per_task_budget" },
    });
    expect(
      evaluate(
        event(),
        [event()],
        parseConfig(config, { budgets: { perTask: { amount: "100" } } }),
        now,
      ),
    ).toMatchObject({ body: { reason: "per_task_payment_count" } });
    expect(
      evaluate(event(), [event()], parseConfig(config, { budgets: { perTask: null } }), now),
    ).toMatchObject({ body: { reason: "per_agent_budget" } });
    expect(
      evaluate(
        event(),
        [event()],
        parseConfig(config, { budgets: { perTask: null, perAgent: { amount: "100" } } }),
        now,
      ),
    ).toMatchObject({ body: { reason: "per_agent_payment_count" } });
  });

  test("count windows include the boundary, use attemptedAt and exclude past and future payments", () => {
    const budget = { asset: "USDC", maxPayments: 1, window: "1h" as const };
    const config = parseConfig(base, { budgets: { global: budget } });
    const boundary = event({
      ts: "2026-09-08T10:00:00.000Z",
      attemptedAt: "2026-09-08T11:00:00.000Z",
    });
    expect(countForBudget(event(), [boundary], budget, "global", now)).toBe("1");
    expect(evaluate(event(), [boundary], config, now).allowed).toBe(false);
    expect(evaluate(event(), [boundary], config, now + 1).allowed).toBe(true);
    expect(
      countForBudget(
        event(),
        [event({ ts: "2026-09-08T10:59:59.999Z" }), event({ ts: "2026-09-08T12:00:00.001Z" })],
        budget,
        "global",
        now,
      ),
    ).toBe("0");
  });

  test("count budgets use exact contract identity and optional network narrowing", () => {
    const config = parseConfig(base, { budgets: { global: { asset: "USDC", maxPayments: 1 } } });
    expect(
      evaluate(
        event(),
        [
          event({ network: "eip155:84532", asset: "0x036cbd53842c5426634e7929541ec2318f3dcf7e" }),
          event({ asset: "custom" }),
        ],
        config,
        now,
      ).allowed,
    ).toBe(true);
    expect(
      evaluate(
        event(),
        [event()],
        parseConfig(config, { budgets: { global: { network: "eip155:84532" } } }),
        now,
      ).allowed,
    ).toBe(true);
    expect(
      evaluate(
        event({ asset: "custom", assetSymbol: "USDC" }),
        [event({ asset: "custom" })],
        parseConfig(config, { policy: { unknownAsset: "allow" } }),
        now,
      ).allowed,
    ).toBe(true);
    expect(
      evaluate(
        event({ asset: "custom" }),
        [event({ asset: "CUSTOM" })],
        parseConfig(config, {
          policy: { unknownAsset: "allow" },
          budgets: { global: { asset: "custom" } },
        }),
        now,
      ),
    ).toMatchObject({ body: { reason: "global_payment_count", spent: "1" } });
  });

  test("a counted reservation retry consumes neither another count nor another amount", () => {
    const config = parseConfig(base, {
      budgets: { global: { asset: "USDC", amount: "7", maxPayments: 1 } },
    });
    const reserved = event();
    expect(evaluate(reserved, [reserved], config, now)).toEqual({ allowed: true });
    const failed = event({ settlementStatus: "failed" });
    expect(evaluate(failed, [failed, reserved], config, now)).toMatchObject({
      body: { reason: "global_budget" },
    });
    expect(
      evaluate(
        failed,
        [failed, reserved],
        parseConfig(config, { budgets: { global: { amount: "100" } } }),
        now,
      ),
    ).toMatchObject({ body: { reason: "global_payment_count" } });
  });

  test("expired or future unknown reservations count again but confirmed retries do not", () => {
    const config = parseConfig(base, {
      budgets: { global: { asset: "USDC", maxPayments: 1, window: "1h" } },
    });
    for (const ts of ["2026-09-08T10:00:00.000Z", "2026-09-08T13:00:00.000Z"]) {
      const prior = event({ ts });
      expect(evaluate(prior, [prior, event()], config, now)).toMatchObject({
        body: { reason: "global_payment_count" },
      });
      const confirmed = { ...prior, settlementStatus: "confirmed" as const };
      expect(evaluate(confirmed, [confirmed, event()], config, now)).toEqual({ allowed: true });
    }
    const failed = event({ settlementStatus: "failed" });
    const state: PolicyState = {
      reserved: failed,
      spent: { perTask: "0", perAgent: "0", global: "7" },
      counts: { perTask: "0", perAgent: "0", global: "1" },
    };
    expect(evaluateWithState(failed, state, config, now)).toMatchObject({
      body: { reason: "global_payment_count" },
    });
  });
});

describe("safe executable policy remedies", () => {
  test.each(scopes)(
    "amount and count hints raise the %s bound enough for the blocked payment",
    (scope: Scope) => {
      const proposed = event({ amount: "35" });
      const amountConfig = parseConfig(base, {
        budgets: { [scope]: { asset: "USDC", amount: "10" } },
      });
      const amountDecision = evaluate(proposed, [event()], amountConfig, now);
      expect(amountDecision).toMatchObject({
        body: { fix: `taximeter config set budgets.${scope}.amount 42` },
      });
      expect(
        evaluate(
          proposed,
          [event()],
          parseConfig(amountConfig, { budgets: { [scope]: { amount: "42" } } }),
          now,
        ).allowed,
      ).toBe(true);
      const countConfig = parseConfig(base, {
        budgets: { [scope]: { asset: "USDC", maxPayments: 1 } },
      });
      expect(evaluate(proposed, [event(), event()], countConfig, now)).toMatchObject({
        body: { fix: `taximeter config set budgets.${scope}.maxPayments 3`, remaining: "0" },
      });
      expect(
        evaluate(
          proposed,
          [event(), event()],
          parseConfig(countConfig, { budgets: { [scope]: { maxPayments: 3 } } }),
          now,
        ).allowed,
      ).toBe(true);
    },
  );

  test("single-payment hints name the exact sufficient atomic amount", () => {
    const config = parseConfig({ policy: { maxSinglePayment: "6" } });
    expect(evaluate(event(), [], config, now)).toMatchObject({
      body: { fix: "taximeter config set policy.maxSinglePayment 7" },
    });
    expect(
      evaluate(event(), [], parseConfig(config, { policy: { maxSinglePayment: "7" } }), now)
        .allowed,
    ).toBe(true);
  });

  test.each([
    [{ denyHosts: ["api.example.test"] }, "denyHosts"],
    [{ allowHosts: ["elsewhere"] }, "allowHosts"],
    [{ allowPayTo: ["elsewhere"] }, "allowPayTo"],
  ] as const)(
    "list remedies use static JSON instead of interpolating untrusted labels",
    (policy, key) => {
      expect(evaluate(event(), [], parseConfig({ policy }), now)).toMatchObject({
        body: { fix: `taximeter config set policy.${key} "[]"` },
      });
      const dangerous = event({
        host: '$(bad);" & bad',
        payTo: '$(bad);" & bad',
        asset: '$(bad);" & bad',
      });
      const decision = evaluate(
        dangerous,
        [],
        parseConfig({ policy: { [key]: ["elsewhere"] } }),
        now,
      );
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) expect(decision.body.fix).not.toContain("bad");
    },
  );

  test("limits at schema ceilings get valid commands disabling the exhausted budget", () => {
    const config = parseConfig(base, {
      budgets: { global: { asset: "USDC", maxPayments: Number.MAX_SAFE_INTEGER } },
    });
    const state: PolicyState = {
      reserved: undefined,
      spent: { perTask: "0", perAgent: "0", global: "9".repeat(78) },
      counts: { perTask: "0", perAgent: "0", global: Number.MAX_SAFE_INTEGER.toString() },
    };
    expect(evaluateWithState(event(), state, config, now)).toMatchObject({
      body: { fix: "taximeter config set budgets.global null" },
    });
    const amountConfig = parseConfig(base, {
      budgets: { global: { asset: "USDC", amount: "9".repeat(78) } },
    });
    expect(evaluateWithState(event(), state, amountConfig, now)).toMatchObject({
      body: { fix: "taximeter config set budgets.global null" },
    });
    expect(
      evaluateWithState(event(), state, parseConfig(config, { budgets: { global: null } }), now)
        .allowed,
    ).toBe(true);
  });
});
