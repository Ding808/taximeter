import { z } from "zod";

const metadata = z.record(z.string(), z.unknown()).nullish();
const text = z.string().nullish();
// Wire integers may have leading zeros; canonicalize only the parsed copy.
export const wireAmountSchema = z
  .string()
  .max(256)
  .regex(/^[0-9]+$/)
  .transform((value) => BigInt(value).toString());
export const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
export const authorizationSchema = z.looseObject({
  from: addressSchema,
  to: addressSchema,
  value: wireAmountSchema,
  validAfter: wireAmountSchema,
  validBefore: wireAmountSchema,
  nonce: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
});
export const eip3009Schema = z.looseObject({
  signature: z
    .string()
    .regex(/^0x(?:[0-9a-fA-F]{2})*$/)
    .optional(),
  authorization: authorizationSchema,
});
export const resourceSchema = z.looseObject({
  url: z.string().min(1),
  description: text,
  mimeType: text,
});
const common = {
  scheme: z.string(),
  network: z.string(),
  asset: z.string().min(1),
  payTo: z.string().min(1),
  maxTimeoutSeconds: z.number().positive(),
  extra: metadata,
};
export const requirementsV1Schema = z.looseObject({
  ...common,
  maxAmountRequired: wireAmountSchema,
  resource: z.string().min(1),
  description: z.string(),
  mimeType: text,
  outputSchema: metadata,
});
export const requirementsV2Schema = z.looseObject({ ...common, amount: wireAmountSchema });
export const requiredV1Schema = z.looseObject({
  x402Version: z.literal(1),
  error: text,
  accepts: z.array(requirementsV1Schema).min(1),
});
export const requiredV2Schema = z.looseObject({
  x402Version: z.literal(2),
  error: text,
  resource: resourceSchema,
  accepts: z.array(requirementsV2Schema).min(1),
  extensions: metadata,
});
export const payloadV1Schema = z.looseObject({
  x402Version: z.literal(1),
  scheme: z.literal("exact"),
  network: z.string(),
  payload: eip3009Schema,
});
export const payloadV2Schema = z.looseObject({
  x402Version: z.literal(2),
  accepted: requirementsV2Schema.extend({ scheme: z.literal("exact") }),
  resource: resourceSchema.nullish(),
  payload: eip3009Schema,
  extensions: metadata,
});
export const settlementSchema = z.looseObject({
  success: z.boolean(),
  transaction: z.string(),
  network: z.string(),
  payer: z.string().optional(),
  errorReason: z.string().optional(),
  errorMessage: z.string().optional(),
  amount: wireAmountSchema.optional(),
});
