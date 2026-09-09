import { expect, test, vi } from "vitest";
import { parseConfig } from "../src/config";
import { Meter } from "../src/core";
import { totals } from "../src/ledger/derive";
import { Ledger } from "../src/ledger/store";
import { encode, fixturePayer, paymentHeader } from "./fixtures/upstream";
import { event } from "./helpers";

test.each(["amount", "count"])(
  "paid intake enforces an exact %s cap without reading full history",
  (kind) => {
    const ledger = new Ledger(":memory:");
    const history = 3_000;
    const amount = (BigInt(history + 20) * 7n).toString();
    const meter = new Meter(
      ledger,
      parseConfig({
        budgets: {
          perTask: null,
          perAgent: null,
          global: {
            amount: kind === "amount" ? amount : "999999999999999999",
            ...(kind === "count" ? { maxPayments: history + 20 } : {}),
            window: "24h",
          },
        },
      }),
    );
    const ts = new Date(Date.now() - 3_600_000).toISOString();
    try {
      ledger.transaction(() => {
        for (let index = 0; index < history; index++) ledger.append(event({ ts }));
      });
      const rejectReplay = () => {
        throw new Error("Hot path attempted to read full ledger history");
      };
      const replay = [
        vi.spyOn(ledger, "view").mockImplementation(rejectReplay),
        vi.spyOn(ledger, "events").mockImplementation(rejectReplay),
        vi.spyOn(ledger, "outcomes").mockImplementation(rejectReplay),
      ];
      const url = "https://api.example.test/v2";
      try {
        for (let index = 1; index <= 20; index++) {
          const intake = meter.begin({ url, method: "GET", headers: paymentHeader(2, index, url) });
          expect(intake.body).toBeUndefined();
          expect(
            intake.payment,
            "An unmetered fail-open response is not a successful reservation",
          ).toBeDefined();
          expect(intake.attempt).toBeDefined();
          meter.complete(intake, {
            status: 200,
            headers: {
              "payment-response": encode({
                success: true,
                transaction: `0x${index.toString(16).padStart(64, "0")}`,
                network: "eip155:8453",
                payer: fixturePayer,
              }),
            },
          });
        }
        expect(
          meter.begin({ url, method: "GET", headers: paymentHeader(2, 21, url) }).body,
        ).toEqual({
          error: "blocked_by_taximeter",
          reason: kind === "amount" ? "global_budget" : "global_payment_count",
          budget: kind === "amount" ? amount : (history + 20).toString(),
          spent: kind === "amount" ? amount : (history + 20).toString(),
          remaining: "0",
          fix: expect.stringMatching(
            /^taximeter config set budgets\.global\.(amount|maxPayments) /,
          ),
        });
        const retry = meter.begin({ url, method: "GET", headers: paymentHeader(2, 1, url) });
        expect(retry.payment).toBeDefined();
        expect(retry.body).toBeUndefined();
        for (const read of replay) expect(read).not.toHaveBeenCalled();
      } finally {
        for (const read of replay) read.mockRestore();
      }
      expect(totals(ledger.view())[0]?.amount).toBe(amount);
      expect(ledger.view().filter((payment) => payment.status === "blocked")).toHaveLength(1);
      expect(ledger.diagnostics()).toEqual([]);
    } finally {
      ledger.close();
    }
  },
);
