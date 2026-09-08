import { z } from "zod";
import { amountSchema, type Outcome, type PaymentEvent } from "../model";

export const totalSchema = z.object({
  network: z.string(),
  asset: z.string(),
  assetSymbol: z.string().optional(),
  decimals: z.number().int(),
  decimalsKnown: z.boolean(),
  amount: amountSchema,
  confirmedAmount: amountSchema,
  unknownAmount: amountSchema,
});
export type Total = z.infer<typeof totalSchema>;
export function assetKey(event: Pick<PaymentEvent, "network" | "asset">): string {
  return `${event.network}/${event.asset.toLowerCase()}`;
}

function order(a: { ts: string; id: string }, b: { ts: string; id: string }): number {
  return a.ts.localeCompare(b.ts) || a.id.localeCompare(b.id);
}

/** Stable replay: confirmed evidence wins; otherwise the latest outcome applies. */
export function deriveEvents(events: PaymentEvent[], outcomes: Outcome[] = []): PaymentEvent[] {
  const seenIds = new Set<string>();
  const seenPayments = new Set<string>();
  const latest = new Map<string, Outcome>();
  for (const outcome of [...outcomes].sort(order)) {
    if (latest.get(outcome.paymentId)?.status !== "confirmed" || outcome.status === "confirmed") {
      latest.set(outcome.paymentId, outcome);
    }
  }
  const result: PaymentEvent[] = [];
  for (const event of [...events].sort(order)) {
    if (seenIds.has(event.id)) continue;
    seenIds.add(event.id);
    if (event.status === "observed") {
      if (seenPayments.has(event.paymentKey)) continue;
      seenPayments.add(event.paymentKey);
    }
    const outcome = latest.get(event.id);
    const status =
      event.settlementStatus === "confirmed"
        ? "confirmed"
        : (outcome?.status ?? event.settlementStatus);
    result.push({
      ...event,
      settlementStatus: status,
      settlement_unknown: event.status === "observed" && status === "unknown",
      ...(outcome?.txHash ? { txHash: outcome.txHash } : {}),
    });
  }
  return result;
}

export function countsAsSpend(event: PaymentEvent): boolean {
  return event.status === "observed" && event.settlementStatus !== "failed";
}

/** Never use a SQLite SUM or floating-point conversion for money. */
export function totals(events: PaymentEvent[]): Total[] {
  const groups = new Map<string, Total>();
  for (const event of deriveEvents(events)) {
    if (!countsAsSpend(event)) continue;
    const key = assetKey(event);
    const current = groups.get(key) ?? {
      network: event.network,
      asset: event.asset.toLowerCase(),
      assetSymbol: event.assetSymbol,
      decimals: event.decimals,
      decimalsKnown: event.decimalsKnown,
      amount: "0",
      confirmedAmount: "0",
      unknownAmount: "0",
    };
    const amount = BigInt(event.amount);
    current.amount = (BigInt(current.amount) + amount).toString();
    if (event.settlementStatus === "confirmed") {
      current.confirmedAmount = (BigInt(current.confirmedAmount) + amount).toString();
    } else {
      current.unknownAmount = (BigInt(current.unknownAmount) + amount).toString();
    }
    groups.set(key, current);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, total]) => total);
}

export function formatAmount(amount: string, decimals: number): string {
  const integer = BigInt(amount).toString();
  if (decimals === 0) return integer;
  const padded = integer.padStart(decimals + 1, "0");
  return `${padded.slice(0, -decimals)}.${padded.slice(-decimals)}`;
}
