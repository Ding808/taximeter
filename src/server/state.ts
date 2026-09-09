import { matchesAsset } from "../assets";
import type { TaximeterConfig } from "../config";
import { countsAsSpend, totals } from "../ledger/derive";
import type { Ledger } from "../ledger/store";
import type { PaymentEvent } from "../model";
import { totalsForBudget } from "../policy";
import { version } from "../version";
import { dashboardStateSchema } from "./schema";

function groups(events: PaymentEvent[], field: "taskId" | "agentId" | "host") {
  const groups = new Map<string | null, PaymentEvent[]>();
  for (const event of events) {
    const key = event[field] ?? null;
    const members = groups.get(key) ?? [];
    members.push(event);
    groups.set(key, members);
  }
  return [...groups].flatMap(([key, members]) =>
    totals(members).map((total) => ({ key, ...total })),
  );
}

export function dashboardState(ledger: Ledger, config: TaximeterConfig, now = Date.now()) {
  const events = ledger.view();
  const total = totals(events);
  const budget = config.budgets.global;
  const budgets = budget
    ? total
        .filter(
          (total) =>
            matchesAsset(budget.asset, total) &&
            (!budget.network || budget.network === total.network),
        )
        .map((total) => {
          const representative = events.find(
            (event) => event.network === total.network && event.asset.toLowerCase() === total.asset,
          );
          const { amount: spent, count } = representative
            ? totalsForBudget(representative, events, budget, "global", now)
            : { amount: "0", count: "0" };
          const remaining =
            budget.amount === undefined ? null : BigInt(budget.amount) - BigInt(spent);
          const countRemaining =
            budget.maxPayments === undefined ? null : BigInt(budget.maxPayments) - BigInt(count);
          return {
            network: total.network,
            asset: total.asset,
            limit: budget.amount ?? null,
            spent,
            remaining: remaining === null ? null : (remaining < 0n ? 0n : remaining).toString(),
            count,
            countLimit: budget.maxPayments?.toString() ?? null,
            countRemaining:
              countRemaining === null
                ? null
                : (countRemaining < 0n ? 0n : countRemaining).toString(),
            window: budget.window ?? null,
          };
        })
    : [];
  const hour = new Date(now);
  hour.setUTCMinutes(0, 0, 0);
  const hours = Array.from({ length: 24 }, (_, index) => {
    const start = hour.getTime() - (23 - index) * 3_600_000;
    const rows = events.filter((event) => {
      const ts = Date.parse(event.attemptedAt ?? event.ts);
      return ts >= start && ts < start + 3_600_000 && ts <= now;
    });
    return { ts: new Date(start).toISOString(), totals: totals(rows) };
  });
  return dashboardStateSchema.parse({
    version,
    generatedAt: new Date(now).toISOString(),
    totalEvents: events.length,
    blockedEvents: events.filter((event) => event.status === "blocked").length,
    unknownEvents: events.filter(
      (event) => countsAsSpend(event) && event.settlementStatus === "unknown",
    ).length,
    totals: total,
    events: [...events]
      .reverse()
      .slice(0, 30)
      .map(({ raw: _raw, ...event }) => event),
    diagnostics: ledger.diagnostics().slice(-10).reverse(),
    groups: {
      task: groups(events, "taskId"),
      agent: groups(events, "agentId"),
      host: groups(events, "host"),
    },
    hours,
    globalBudget: budget,
    budgets,
    proxy: { port: config.ports.proxy, upstream: config.upstream },
  });
}
