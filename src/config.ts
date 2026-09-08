import { z } from "zod";
import { amountSchema, httpUrlSchema, labelSchema } from "./model";

export const budgetSchema = z.strictObject({
  amount: amountSchema,
  asset: labelSchema,
  network: labelSchema.optional(),
  window: z.enum(["1h", "24h", "7d", "30d"]).optional(),
});
export type Budget = z.infer<typeof budgetSchema>;
export const policySchema = z.strictObject({
  allowHosts: z.array(labelSchema).default([]),
  denyHosts: z.array(labelSchema).default([]),
  allowPayTo: z.array(labelSchema).default([]),
  maxSinglePayment: amountSchema.nullable().default("1000000"),
  maxSingleAsset: labelSchema.default("USDC"),
});
export const portsSchema = z.strictObject({
  proxy: z.number().int().min(0).max(65535).default(8402),
  dashboard: z.number().int().min(0).max(65535).default(8403),
});
export const configSchema = z.strictObject({
  budgets: z
    .strictObject({
      perTask: budgetSchema.nullable().default({ amount: "5000000", asset: "USDC" }),
      perAgent: budgetSchema
        .nullable()
        .default({ amount: "50000000", asset: "USDC", window: "24h" }),
      global: budgetSchema
        .nullable()
        .default({ amount: "100000000", asset: "USDC", window: "24h" }),
    })
    .prefault({}),
  policy: policySchema.prefault({}),
  ports: portsSchema.prefault({}),
  db: z.string().min(1).default("~/.taximeter/ledger.db"),
  upstream: httpUrlSchema.optional(),
});
export type TaximeterConfig = z.infer<typeof configSchema>;

export const configPatchSchema = z.strictObject({
  budgets: z
    .strictObject({
      perTask: budgetSchema.partial().nullable().optional(),
      perAgent: budgetSchema.partial().nullable().optional(),
      global: budgetSchema.partial().nullable().optional(),
    })
    .optional(),
  policy: policySchema.partial().optional(),
  ports: portsSchema.partial().optional(),
  db: z.string().min(1).optional(),
  upstream: httpUrlSchema.optional(),
});

/** Merge validated layers from lowest to highest priority without mutating inputs. */
export function parseConfig(...layers: unknown[]): TaximeterConfig {
  let current = configSchema.parse({});
  for (const input of layers) {
    const layer = configPatchSchema.parse(input);
    const budgets = { ...current.budgets };
    for (const key of ["perTask", "perAgent", "global"] as const) {
      const next = layer.budgets?.[key];
      if (next !== undefined)
        budgets[key] = next === null ? null : budgetSchema.parse({ ...budgets[key], ...next });
    }
    current = configSchema.parse({
      ...current,
      ...layer,
      budgets,
      policy: { ...current.policy, ...layer.policy },
      ports: { ...current.ports, ...layer.ports },
    });
  }
  return current;
}
