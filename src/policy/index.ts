import { matchesAsset } from "../assets";
import type { Budget, TaximeterConfig } from "../config";
import { assetKey, countsAsSpend, deriveEvents } from "../ledger/derive";
import type { BlockedBody, PaymentEvent } from "../model";

export type Decision = { allowed: true } | { allowed: false; body: BlockedBody };
export type Scope = "perTask" | "perAgent" | "global";
const windows = { "1h": 3_600_000, "24h": 86_400_000, "7d": 604_800_000, "30d": 2_592_000_000 };

function deny(reason: string, budget: string | null = null, spent = "0"): Decision {
  const difference = budget === null ? null : BigInt(budget) - BigInt(spent);
  return {
    allowed: false,
    body: {
      error: "blocked_by_taximeter",
      reason,
      budget,
      spent,
      remaining: difference === null ? null : (difference < 0n ? 0n : difference).toString(),
    },
  };
}

export function spentForBudget(
  proposed: PaymentEvent,
  events: PaymentEvent[],
  budget: Budget,
  scope: Scope,
  now: number,
): string {
  const start = budget.window ? now - windows[budget.window] : -Infinity;
  let spent = 0n;
  for (const event of deriveEvents(events)) {
    if (!countsAsSpend(event) || assetKey(event) !== assetKey(proposed)) continue;
    const ts = Date.parse(event.attemptedAt ?? event.ts);
    if (ts < start || ts > now) continue;
    if (scope === "perTask" && event.taskId !== proposed.taskId) continue;
    if (scope === "perAgent" && event.agentId !== proposed.agentId) continue;
    spent += BigInt(event.amount);
  }
  return spent.toString();
}

/** Pure, synchronous budget decision. The caller must reserve in the same transaction. */
export function evaluate(
  proposed: PaymentEvent,
  events: PaymentEvent[],
  config: TaximeterConfig,
  now: number,
): Decision {
  const { policy } = config;
  const host = proposed.host.toLowerCase();
  if (policy.denyHosts.some((value) => value.toLowerCase() === host)) return deny("host_denied");
  if (
    policy.allowHosts.length > 0 &&
    !policy.allowHosts.some((value) => value.toLowerCase() === host)
  )
    return deny("host_not_allowed");
  if (
    policy.allowPayTo.length > 0 &&
    !policy.allowPayTo.some((value) => value.toLowerCase() === proposed.payTo.toLowerCase())
  )
    return deny("recipient_not_allowed");
  if (
    policy.maxSinglePayment !== null &&
    matchesAsset(policy.maxSingleAsset, proposed) &&
    BigInt(proposed.amount) > BigInt(policy.maxSinglePayment)
  )
    return deny("max_single_payment", policy.maxSinglePayment);

  const reserved = events.find(
    (event) => event.paymentKey === proposed.paymentKey && countsAsSpend(event),
  );
  for (const scope of ["perTask", "perAgent", "global"] as const) {
    const budget = config.budgets[scope];
    if (
      !budget ||
      !matchesAsset(budget.asset, proposed) ||
      (budget.network && budget.network !== proposed.network)
    )
      continue;
    const spent = spentForBudget(proposed, events, budget, scope, now);
    const reservedTime = reserved ? Date.parse(reserved.attemptedAt ?? reserved.ts) : -Infinity;
    const inWindow =
      reservedTime <= now && (!budget.window || reservedTime >= now - windows[budget.window]);
    const increment =
      reserved && (reserved.settlementStatus === "confirmed" || inWindow)
        ? 0n
        : BigInt(proposed.amount);
    if (BigInt(spent) + increment > BigInt(budget.amount)) {
      const reason =
        scope === "perTask"
          ? "per_task_budget"
          : scope === "perAgent"
            ? "per_agent_budget"
            : "global_budget";
      return deny(reason, budget.amount, spent);
    }
  }
  return { allowed: true };
}
