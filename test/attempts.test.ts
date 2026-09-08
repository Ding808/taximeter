import { v7 } from "uuid";
import { expect, test } from "vitest";
import { parseConfig } from "../src/config";
import { deriveEvents, totals } from "../src/ledger/derive";
import { type Outcome, outcomeSchema } from "../src/model";
import { evaluate } from "../src/policy";
import { event } from "./helpers";

test("failed duplicate attempt cannot release a pending authorization", () => {
  const payment = event();
  const a = v7();
  const b = v7();
  const log: Outcome[] = [];
  const append = (attemptId: string, status: Outcome["status"]) => {
    log.push(
      outcomeSchema.parse({
        id: v7(),
        ts: payment.ts,
        attemptedAt: payment.ts,
        paymentId: payment.id,
        attemptId,
        status,
      }),
    );
  };
  append(a, "unknown");
  append(b, "unknown");
  append(b, "failed");
  expect(deriveEvents([payment], log)[0]?.settlementStatus).toBe("unknown");
  expect(totals(deriveEvents([payment], log))[0]?.amount).toBe("7");
  append(a, "failed");
  expect(totals(deriveEvents([payment], log))).toEqual([]);
  append(a, "confirmed");
  append(a, "failed");
  append(b, "unknown");
  expect(deriveEvents([payment], log)[0]?.settlementStatus).toBe("confirmed");
});

test("retrying old uncertain exposure must reacquire current window capacity", () => {
  const now = Date.parse("2026-09-08T12:00:00.000Z");
  const old = event({ ts: "2026-09-01T12:00:00.000Z" });
  const config = parseConfig({ budgets: { global: { amount: "7" } } });
  expect(evaluate(old, [old, event()], config, now).allowed).toBe(false);
  expect(evaluate(old, [old], config, now).allowed).toBe(true);
  const start = outcomeSchema.parse({
    id: v7(),
    ts: new Date(now).toISOString(),
    attemptedAt: new Date(now).toISOString(),
    paymentId: old.id,
    attemptId: v7(),
    status: "unknown",
  });
  const view = deriveEvents([old], [start]);
  expect(view[0]?.ts).toBe(old.ts);
  expect(view[0]?.attemptedAt).toBe(start.ts);
  expect(evaluate(event(), view, config, now).allowed).toBe(false);
  const confirmed = event({ ...old, settlementStatus: "confirmed" });
  expect(evaluate(confirmed, [confirmed, event()], config, now).allowed).toBe(true);
});
