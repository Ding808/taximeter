import { v7 } from "uuid";
import { parseConfig, type TaximeterConfig } from "./config";
import type { Ledger } from "./ledger/store";
import {
  type BlockedBody,
  type Diagnostic,
  type Outcome,
  type PaymentEvent,
  paymentEventSchema,
} from "./model";
import { evaluate } from "./policy";
import type { WireRequest, WireResponse } from "./rails/types";
import { X402Rail } from "./rails/x402";

export type Intake = { body?: BlockedBody; payment?: PaymentEvent; attempt?: Outcome };

/** Shared proxy/SDK intake. Every reservation is committed before returning to I/O. */
export class Meter {
  readonly rail: X402Rail;
  readonly config: TaximeterConfig;
  constructor(
    readonly ledger: Ledger,
    config: TaximeterConfig,
  ) {
    this.config = parseConfig(config);
    this.rail = new X402Rail({
      diagnostic: (code, resource, message) => this.diagnose(code, resource, message),
    });
  }

  diagnose(code: Diagnostic["code"], resource: string, message: string): void {
    try {
      this.ledger.diagnose(code, resource, message);
    } catch {
      process.stderr.write(
        "Taximeter: storage unavailable; traffic is passing without reliable budget enforcement.\n",
      );
    }
  }

  begin(request: WireRequest): Intake {
    const proposed = this.rail.parse(request);
    if (!proposed) return {};
    try {
      return this.ledger.transaction(() => {
        const events = this.ledger.view();
        const decision = evaluate(proposed, events, this.config, Date.now());
        if (!decision.allowed) {
          this.ledger.append(
            paymentEventSchema.parse({
              ...proposed,
              status: "blocked",
              reason: decision.body.reason,
              settlement_unknown: false,
            }),
          );
          return { body: decision.body };
        }
        const previous = events.find(
          (event) => event.status === "observed" && event.paymentKey === proposed.paymentKey,
        );
        const payment = previous ?? proposed;
        if (!previous) this.ledger.append(payment);
        const ts = new Date().toISOString();
        const attempt: Outcome = {
          id: v7(),
          ts,
          paymentId: payment.id,
          attemptId: v7(),
          status: "unknown",
          attemptedAt:
            previous?.settlementStatus === "confirmed" ? (previous.attemptedAt ?? previous.ts) : ts,
        };
        this.ledger.appendOutcome(attempt);
        return { payment, attempt };
      });
    } catch {
      this.diagnose(
        "storage_failed",
        request.url,
        "Could not reserve budget; request forwarded without metering.",
      );
      return {};
    }
  }

  observe(request: WireRequest, response: WireResponse): void {
    this.rail.parse(request, response);
  }

  complete(intake: Intake, response?: WireResponse): void {
    if (!intake.payment || !intake.attempt) return;
    const result = response
      ? this.rail.settlement(intake.payment, response)
      : ({ status: "unknown", reason: "settlement_unknown" } as const);
    try {
      this.ledger.appendOutcome({
        ...intake.attempt,
        ...result,
        id: v7(),
        ts: new Date().toISOString(),
      });
      if (result.status === "unknown")
        this.diagnose(
          "settlement_unknown",
          intake.payment.resource,
          "No conclusive settlement response; authorization remains reserved.",
        );
    } catch {
      this.diagnose(
        "storage_failed",
        intake.payment.resource,
        "Could not record settlement outcome; original authorization remains reserved.",
      );
    }
  }
}
