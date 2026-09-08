import { z } from "zod";
import { budgetSchema } from "../config";
import { totalSchema } from "../ledger/derive";
import { diagnosticSchema, integerStringSchema, paymentEventSchema } from "../model";

export const dashboardEventSchema = paymentEventSchema.omit({ raw: true });
export const groupSchema = totalSchema.extend({ key: z.string().nullable() });
export const dashboardStateSchema = z.object({
  version: z.literal("0.1.0"),
  generatedAt: z.iso.datetime(),
  totalEvents: z.number().int(),
  blockedEvents: z.number().int(),
  unknownEvents: z.number().int(),
  totals: z.array(totalSchema),
  events: z.array(dashboardEventSchema),
  diagnostics: z.array(diagnosticSchema),
  groups: z.object({
    task: z.array(groupSchema),
    agent: z.array(groupSchema),
    host: z.array(groupSchema),
  }),
  hours: z.array(z.object({ ts: z.iso.datetime(), totals: z.array(totalSchema) })),
  globalBudget: budgetSchema.nullable(),
  budgets: z.array(
    z.object({
      network: z.string(),
      asset: z.string(),
      limit: integerStringSchema,
      spent: integerStringSchema,
      remaining: integerStringSchema,
      window: z.string().nullable(),
    }),
  ),
  proxy: z.object({ port: z.number().int(), upstream: z.string().optional() }),
});
export type DashboardState = z.infer<typeof dashboardStateSchema>;
