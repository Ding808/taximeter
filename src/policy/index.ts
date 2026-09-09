import { assetMetadata, matchesAsset } from "../assets";
import type { Budget, TaximeterConfig } from "../config";
import { assetKey, countsAsSpend, deriveEvents } from "../ledger/derive";
import type { BlockedBody, PaymentEvent } from "../model";

export type Decision = { allowed: true } | { allowed: false; body: BlockedBody };
export type Scope = "perTask" | "perAgent" | "global";
export type PolicyState = {
  reserved: PaymentEvent | undefined;
  spent: Record<Scope, string>;
  counts: Record<Scope, string>;
};
const windows = { "1h": 3_600_000, "24h": 86_400_000, "7d": 604_800_000, "30d": 2_592_000_000 };
const amountReasons = {
  perTask: "per_task_budget",
  perAgent: "per_agent_budget",
  global: "global_budget",
} as const;
const countReasons = {
  perTask: "per_task_payment_count",
  perAgent: "per_agent_payment_count",
  global: "global_payment_count",
} as const;
const fixedRemedies = {
  host_denied: 'taximeter config set policy.denyHosts "[]"',
  host_not_allowed: 'taximeter config set policy.allowHosts "[]"',
  recipient_not_allowed: 'taximeter config set policy.allowPayTo "[]"',
  unknown_asset: "taximeter config set policy.unknownAsset allow",
} as const;
const limitKeys = {
  max_single_payment: "policy.maxSinglePayment",
  per_task_budget: "budgets.perTask.amount",
  per_agent_budget: "budgets.perAgent.amount",
  global_budget: "budgets.global.amount",
  per_task_payment_count: "budgets.perTask.maxPayments",
  per_agent_payment_count: "budgets.perAgent.maxPayments",
  global_payment_count: "budgets.global.maxPayments",
} as const;
type DenyReason = keyof typeof fixedRemedies | keyof typeof limitKeys;

function deny(
  reason: DenyReason,
  budget: string | null = null,
  spent = "0",
  increment = 0n,
): Decision {
  const difference = budget === null ? null : BigInt(budget) - BigInt(spent);
  let fix: string;
  if (reason in fixedRemedies) {
    fix = fixedRemedies[reason as keyof typeof fixedRemedies];
  } else {
    const key = limitKeys[reason as keyof typeof limitKeys];
    const minimum = BigInt(budget as string) + 1n;
    const needed = BigInt(spent) + increment;
    const next = needed > minimum ? needed : minimum;
    const countLimit = key.endsWith(".maxPayments");
    const representable = countLimit
      ? next <= BigInt(Number.MAX_SAFE_INTEGER)
      : next.toString().length <= 78;
    // At the schema ceiling, disabling the affected limit is the only valid relaxation.
    const target = key.startsWith("budgets.") ? key.slice(0, key.lastIndexOf(".")) : key;
    fix = representable
      ? `taximeter config set ${key} ${next}`
      : `taximeter config set ${target} null`;
  }
  return {
    allowed: false,
    body: {
      error: "blocked_by_taximeter",
      reason,
      budget,
      spent,
      remaining: difference === null ? null : (difference < 0n ? 0n : difference).toString(),
      fix,
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
  return totalsForBudget(proposed, events, budget, scope, now).amount;
}

/** Full replay reference for tests, exports, and rebuilding derived state. */
export function countForBudget(
  proposed: PaymentEvent,
  events: PaymentEvent[],
  budget: Budget,
  scope: Scope,
  now: number,
): string {
  return totalsForBudget(proposed, events, budget, scope, now).count;
}

export function totalsForBudget(
  proposed: PaymentEvent,
  events: PaymentEvent[],
  budget: Budget,
  scope: Scope,
  now: number,
): { amount: string; count: string } {
  const start = budget.window ? now - windows[budget.window] : -Infinity;
  let spent = 0n;
  let count = 0n;
  for (const event of deriveEvents(events)) {
    if (!countsAsSpend(event) || assetKey(event) !== assetKey(proposed)) continue;
    const ts = Date.parse(event.attemptedAt ?? event.ts);
    if (ts < start || ts > now) continue;
    if (scope === "perTask" && event.taskId !== proposed.taskId) continue;
    if (scope === "perAgent" && event.agentId !== proposed.agentId) continue;
    spent += BigInt(event.amount);
    count += 1n;
  }
  return { amount: spent.toString(), count: count.toString() };
}

/** Pure, synchronous budget decision. The caller must reserve in the same transaction. */
export function evaluate(
  proposed: PaymentEvent,
  events: PaymentEvent[],
  config: TaximeterConfig,
  now: number,
): Decision {
  const spent: Record<Scope, string> = { perTask: "0", perAgent: "0", global: "0" };
  const counts: Record<Scope, string> = { perTask: "0", perAgent: "0", global: "0" };
  for (const scope of ["perTask", "perAgent", "global"] as const) {
    const budget = config.budgets[scope];
    if (!budget) continue;
    const total = totalsForBudget(proposed, events, budget, scope, now);
    spent[scope] = total.amount;
    counts[scope] = total.count;
  }
  return evaluateWithState(
    proposed,
    {
      reserved: events.find(
        (event) => event.paymentKey === proposed.paymentKey && countsAsSpend(event),
      ),
      spent,
      counts,
    },
    config,
    now,
  );
}

/** Same pure decision using an exact, transactionally read budget snapshot. */
export function evaluateWithState(
  proposed: PaymentEvent,
  state: PolicyState,
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
    policy.unknownAsset === "deny" &&
    !assetMetadata(proposed.network, proposed.asset).decimalsKnown
  )
    return deny("unknown_asset");
  if (
    policy.maxSinglePayment !== null &&
    matchesAsset(policy.maxSingleAsset, proposed) &&
    BigInt(proposed.amount) > BigInt(policy.maxSinglePayment)
  )
    return deny("max_single_payment", policy.maxSinglePayment, "0", BigInt(proposed.amount));

  const reserved = state.reserved && countsAsSpend(state.reserved) ? state.reserved : undefined;
  for (const scope of ["perTask", "perAgent", "global"] as const) {
    const budget = config.budgets[scope];
    if (
      !budget ||
      !matchesAsset(budget.asset, proposed) ||
      (budget.network && budget.network !== proposed.network)
    )
      continue;
    const spent = state.spent[scope];
    const reservedTime = reserved ? Date.parse(reserved.attemptedAt ?? reserved.ts) : -Infinity;
    const inWindow =
      reservedTime <= now && (!budget.window || reservedTime >= now - windows[budget.window]);
    const countIncrement =
      reserved && (reserved.settlementStatus === "confirmed" || inWindow) ? 0n : 1n;
    const increment = countIncrement * BigInt(proposed.amount);
    if (budget.amount !== undefined && BigInt(spent) + increment > BigInt(budget.amount)) {
      return deny(amountReasons[scope], budget.amount, spent, increment);
    }
    const count = state.counts[scope];
    if (
      budget.maxPayments !== undefined &&
      BigInt(count) + countIncrement > BigInt(budget.maxPayments)
    ) {
      return deny(countReasons[scope], budget.maxPayments.toString(), count, countIncrement);
    }
  }
  return { allowed: true };
}
