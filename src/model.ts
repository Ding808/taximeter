import { z } from "zod";

export const amountSchema = z
  .string()
  .max(78)
  .regex(/^(0|[1-9][0-9]*)$/);
export const httpUrlSchema = z.url().refine((value) => {
  const url = new URL(value);
  return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
}, "Expected an HTTP(S) URL without credentials");
export const labelSchema = z.string().min(1).max(256);
export const headersSchema = z.record(z.string(), z.string());
export const requestSchema = z.object({
  url: httpUrlSchema,
  method: z.string().min(1).max(64),
  headers: headersSchema,
});
export const responseSchema = z.object({
  status: z.number().int().min(100).max(599),
  headers: headersSchema,
  body: z.instanceof(Uint8Array).optional(),
});

export const paymentEventSchema = z.object({
  id: z.uuidv7(),
  ts: z.iso.datetime(),
  rail: z.literal("x402"),
  status: z.enum(["observed", "blocked"]),
  reason: z.string().optional(),
  amount: amountSchema,
  decimals: z.number().int().min(0).max(255),
  decimalsKnown: z.boolean(),
  asset: labelSchema,
  assetSymbol: labelSchema.optional(),
  network: labelSchema,
  payTo: labelSchema,
  payer: labelSchema.optional(),
  resource: httpUrlSchema,
  host: labelSchema,
  txHash: z.string().optional(),
  taskId: labelSchema.optional(),
  agentId: labelSchema.optional(),
  raw: z.string(),
  paymentKey: z.string().min(1),
  settlementStatus: z.enum(["unknown", "confirmed", "failed"]).default("unknown"),
  settlement_unknown: z.boolean().default(true),
});
export type PaymentEvent = z.infer<typeof paymentEventSchema>;

export const outcomeSchema = z.object({
  id: z.uuidv7(),
  ts: z.iso.datetime(),
  paymentId: z.uuidv7(),
  status: z.enum(["unknown", "confirmed", "failed"]),
  txHash: z.string().optional(),
  reason: z.string().optional(),
});
export type Outcome = z.infer<typeof outcomeSchema>;
export const diagnosticSchema = z.object({
  id: z.uuidv7(),
  ts: z.iso.datetime(),
  code: z.enum(["parse_failed", "settlement_unknown", "tls_unmetered", "storage_failed"]),
  resource: z.string(),
  message: z.string(),
});
export type Diagnostic = z.infer<typeof diagnosticSchema>;

export const blockedBodySchema = z.object({
  error: z.literal("blocked_by_taximeter"),
  reason: z.string(),
  budget: amountSchema.nullable(),
  spent: amountSchema,
  remaining: amountSchema.nullable(),
});
export type BlockedBody = z.infer<typeof blockedBodySchema>;
