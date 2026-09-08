import type { z } from "zod";
import type { PaymentEvent, requestSchema, responseSchema } from "../model";

export type WireRequest = z.infer<typeof requestSchema>;
export type WireResponse = z.infer<typeof responseSchema>;
export interface Rail {
  readonly name: string;
  detect(request: WireRequest, response?: WireResponse): boolean;
  parse(request: WireRequest, response?: WireResponse): PaymentEvent | null;
}
