import { z } from "zod";
import { configPatchSchema, type TaximeterConfig } from "../config";
import { parseAmountInput } from "../config/amount-input";

const amount = z.string().min(1).optional();
const count = z
  .string()
  .regex(/^[1-9][0-9]*$/, "Use a positive payment count without units")
  .transform(Number)
  .pipe(z.number().int().positive().max(Number.MAX_SAFE_INTEGER))
  .optional();
export const overridesSchema = z.strictObject({
  budgetGlobal: amount,
  budgetTask: amount,
  budgetAgent: amount,
  maxPaymentsGlobal: count,
  maxPaymentsTask: count,
  maxPaymentsAgent: count,
  maxSingle: amount,
  allowHost: z.array(z.string().min(1).max(256)).optional(),
  denyHost: z.array(z.string().min(1).max(256)).optional(),
});

export function startOverrides(flags: z.infer<typeof overridesSchema>, config: TaximeterConfig) {
  const budgets: Record<string, unknown> = {};
  const policy: Record<string, unknown> = {};
  const active: { key: string; value: unknown }[] = [];
  for (const [scope, amount, count] of [
    ["global", flags.budgetGlobal, flags.maxPaymentsGlobal],
    ["perTask", flags.budgetTask, flags.maxPaymentsTask],
    ["perAgent", flags.budgetAgent, flags.maxPaymentsAgent],
  ] as const) {
    if (amount === undefined && count === undefined) continue;
    const budget = config.budgets[scope];
    const patch: Record<string, unknown> = budget ? {} : { asset: "USDC" };
    if (amount !== undefined) {
      patch.amount = parseAmountInput(amount, budget?.asset ?? "USDC", budget?.network);
      active.push({ key: `budgets.${scope}.amount`, value: patch.amount });
    }
    if (count !== undefined) {
      patch.maxPayments = count;
      active.push({ key: `budgets.${scope}.maxPayments`, value: count });
    }
    budgets[scope] = patch;
  }
  if (flags.maxSingle !== undefined) {
    policy.maxSinglePayment = parseAmountInput(flags.maxSingle, config.policy.maxSingleAsset);
    active.push({ key: "policy.maxSinglePayment", value: policy.maxSinglePayment });
  }
  if (flags.allowHost !== undefined) {
    policy.allowHosts = flags.allowHost;
    active.push({ key: "policy.allowHosts", value: flags.allowHost });
  }
  if (flags.denyHost !== undefined) {
    policy.denyHosts = flags.denyHost;
    active.push({ key: "policy.denyHosts", value: flags.denyHost });
  }
  return { patch: configPatchSchema.parse({ budgets, policy }), active };
}
