import { createHash } from "node:crypto";
import { v7 } from "uuid";
import { z } from "zod";
import { assetMetadata } from "../assets";
import {
  type Diagnostic,
  labelSchema,
  type Outcome,
  type PaymentEvent,
  paymentEventSchema,
  requestSchema,
  responseSchema,
} from "../model";
import {
  addressSchema,
  payloadV1Schema,
  payloadV2Schema,
  requiredV1Schema,
  requiredV2Schema,
  settlementSchema,
} from "./schemas";
import type { Rail, WireRequest, WireResponse } from "./types";

type Report = (code: Diagnostic["code"], resource: string, message: string) => void;
type Challenge = z.infer<typeof requiredV1Schema>;
type Settlement = Pick<Outcome, "status" | "txHash" | "reason">;
const headerSchema = z
  .string()
  .max(65_536)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/);

function decodeHeader(input: unknown): unknown {
  const encoded = headerSchema.parse(input);
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, ""))
    throw new Error("Invalid base64");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

export function normalizeNetwork(input: string): string | null {
  if (input === "base") return "eip155:8453";
  if (input === "base-sepolia") return "eip155:84532";
  return /^eip155:[1-9][0-9]*$/.test(input) ? input : null;
}

function contextKey(request: WireRequest): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        request.method,
        request.url,
        request.headers["taximeter-task"],
        request.headers["taximeter-agent"],
        request.headers.authorization,
        request.headers.cookie,
      ]),
    )
    .digest("hex");
}

/** Stateful challenge cache at the intake edge. Unknown data always returns null. */
export class X402Rail implements Rail {
  readonly name = "x402";
  private readonly cache = new Map<string, { challenge: Challenge; expires: number }>();
  private readonly now: () => number;
  private readonly diagnostic: Report;

  constructor(options: { diagnostic?: Report; now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
    this.diagnostic = options.diagnostic ?? (() => {});
  }

  private report(
    resource: string,
    message: string,
    code: Diagnostic["code"] = "parse_failed",
  ): void {
    try {
      this.diagnostic(code, resource, message);
    } catch {
      /* A diagnostic sink must never break traffic. */
    }
  }

  detect(request: WireRequest, response?: WireResponse): boolean {
    return Boolean(
      request.headers["payment-signature"] !== undefined ||
        request.headers["x-payment"] !== undefined ||
        response?.status === 402 ||
        response?.headers["payment-required"] ||
        response?.headers["payment-response"] ||
        response?.headers["x-payment-response"],
    );
  }

  private attribution(request: WireRequest, header: string): string | undefined {
    const value = labelSchema.optional().safeParse(request.headers[header]);
    if (value.success) return value.data;
    this.report(
      request.url,
      "Invalid attribution label; payment assigned to the unattributed bucket.",
    );
    return undefined;
  }

  parse(input: WireRequest, reply?: WireResponse): PaymentEvent | null {
    try {
      const request = requestSchema.parse(input);
      if (reply) {
        const response = responseSchema.parse(reply);
        if (response.status !== 402) return null;
        if (response.headers["payment-required"]) {
          const challenge = requiredV2Schema.parse(
            decodeHeader(response.headers["payment-required"]),
          );
          if (
            !challenge.accepts.some(
              (option) => option.scheme === "exact" && normalizeNetwork(option.network),
            )
          )
            this.report(request.url, "Unsupported payment requirements; forwarded unchanged.");
        } else {
          if (
            !response.body ||
            response.body.byteLength > 65_536 ||
            response.headers["content-encoding"]
          )
            throw new Error("Unavailable v1 body");
          const challenge = requiredV1Schema.parse(
            JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.body)),
          );
          const key = contextKey(request);
          this.cache.delete(key);
          this.cache.set(key, { challenge, expires: this.now() + 300_000 });
          if (this.cache.size > 1000) {
            const oldest = this.cache.keys().next().value;
            if (oldest !== undefined) this.cache.delete(oldest);
          }
        }
        return null;
      }
      const v2Header = request.headers["payment-signature"];
      const v1Header = request.headers["x-payment"];
      if (v2Header === undefined && v1Header === undefined) return null;
      if (v2Header !== undefined && v1Header !== undefined)
        throw new Error("Ambiguous payment headers");
      const original = decodeHeader(v2Header ?? v1Header);
      const raw = JSON.stringify(original);
      const parsed = v2Header ? payloadV2Schema.parse(original) : payloadV1Schema.parse(original);
      const payload = parsed.payload;
      if ("permit2Authorization" in payload || "delegationManager" in payload)
        throw new Error("Unsupported mixed transfer methods");
      const auth = payload.authorization;
      let asset: string;
      let payTo: string;
      let amount: string;
      let network: string | null;
      let extra: Record<string, unknown> | null | undefined;
      if (parsed.x402Version === 2) {
        if (!/^eip155:[1-9][0-9]*$/.test(parsed.accepted.network))
          throw new Error("Unsupported v2 network");
        network = parsed.accepted.network;
        ({ asset, payTo, amount, extra } = parsed.accepted);
      } else {
        if (!["base", "base-sepolia"].includes(parsed.network))
          throw new Error("Unsupported v1 network");
        network = normalizeNetwork(parsed.network);
        const cached = this.cache.get(contextKey(request));
        if (!cached || cached.expires < this.now()) throw new Error("Missing v1 challenge");
        const matches = cached.challenge.accepts.filter(
          (option) =>
            option.scheme === "exact" &&
            option.network === parsed.network &&
            option.payTo.toLowerCase() === auth.to.toLowerCase() &&
            option.maxAmountRequired === auth.value,
        );
        const identities = new Set(matches.map((option) => option.asset.toLowerCase()));
        const selected = matches[0];
        if (!selected || identities.size !== 1) throw new Error("Ambiguous v1 requirements");
        ({ asset, payTo, extra } = selected);
        amount = selected.maxAmountRequired;
      }
      if (extra?.assetTransferMethod !== undefined && extra.assetTransferMethod !== "eip3009")
        throw new Error("Unsupported transfer method");
      if (!network || amount !== auth.value || payTo.toLowerCase() !== auth.to.toLowerCase())
        throw new Error("Inconsistent exact authorization");
      asset = addressSchema.parse(asset).toLowerCase();
      const payer = auth.from.toLowerCase();
      payTo = auth.to.toLowerCase();
      const paymentKey = createHash("sha256")
        .update(
          JSON.stringify([
            network,
            asset,
            payer,
            auth.nonce.toLowerCase(),
            amount,
            payTo,
            auth.validAfter,
            auth.validBefore,
          ]),
        )
        .digest("hex");
      return paymentEventSchema.parse({
        id: v7(),
        ts: new Date(this.now()).toISOString(),
        rail: "x402",
        status: "observed",
        amount,
        asset,
        network,
        payTo,
        payer,
        ...assetMetadata(network, asset),
        resource: request.url,
        host: new URL(request.url).hostname.toLowerCase(),
        taskId: this.attribution(request, "taximeter-task"),
        agentId: this.attribution(request, "taximeter-agent"),
        paymentKey,
        raw,
      });
    } catch {
      const context = z.object({ url: z.string() }).safeParse(input);
      this.report(
        context.data?.url ?? "unknown",
        "Unrecognized or inconsistent x402 data; forwarded unchanged.",
      );
      return null;
    }
  }

  settlement(event: PaymentEvent, input: WireResponse): Settlement {
    try {
      const response = responseSchema.parse(input);
      const header = response.headers["payment-response"] ?? response.headers["x-payment-response"];
      if (!header) return { status: "unknown", reason: "settlement_unknown" };
      const settlement = settlementSchema.parse(decodeHeader(header));
      if (
        normalizeNetwork(settlement.network) !== event.network ||
        (settlement.payer && settlement.payer.toLowerCase() !== event.payer) ||
        (settlement.amount && settlement.amount !== event.amount)
      )
        throw new Error("Settlement mismatch");
      if (settlement.success && settlement.transaction)
        return { status: "confirmed", txHash: settlement.transaction };
      if (!settlement.success && response.status < 500)
        return { status: "failed", reason: settlement.errorReason ?? "settlement_failed" };
      return { status: "unknown", reason: "settlement_unknown" };
    } catch {
      this.report(
        event.resource,
        "Unrecognized settlement evidence; authorization remains reserved.",
      );
      return { status: "unknown", reason: "settlement_unknown" };
    }
  }
}
