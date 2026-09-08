import { expect, test, vi } from "vitest";
import { parseConfig } from "../src/config";
import { Meter } from "../src/core";
import { totals } from "../src/ledger/derive";
import { Ledger } from "../src/ledger/store";
import { encode, fixturePayer, paymentHeader } from "./fixtures/upstream";

test("overlapping duplicate attempts retain exposure until every attempt fails", () => {
  const ledger = new Ledger(":memory:");
  const meter = new Meter(ledger, parseConfig({ budgets: { global: { amount: "7" } } }));
  const input = {
    url: "https://api.example.test/v2",
    method: "GET",
    headers: paymentHeader(2, 1, "https://api.example.test/v2"),
  };
  try {
    const first = meter.begin(input);
    const second = meter.begin(input);
    expect(first.body).toBeUndefined();
    expect(second.body).toBeUndefined();
    const failed = {
      status: 402,
      headers: {
        "payment-response": encode({
          success: false,
          transaction: "",
          network: "eip155:8453",
          payer: fixturePayer,
        }),
      },
    };
    meter.complete(second, failed);
    expect(totals(ledger.view())[0]?.amount).toBe("7");
    expect(meter.begin({ ...input, headers: paymentHeader(2, 2, input.url) }).body?.error).toBe(
      "blocked_by_taximeter",
    );
    meter.complete(first, failed);
    expect(totals(ledger.view())).toEqual([]);
    const retry = meter.begin(input);
    expect(retry.body).toBeUndefined();
    meter.complete(retry);
    expect(ledger.view().find((event) => event.status === "observed")?.settlement_unknown).toBe(
      true,
    );
  } finally {
    ledger.close();
  }
});

test("storage failure preserves traffic and gives a visible local diagnostic", () => {
  const ledger = new Ledger(":memory:");
  const meter = new Meter(ledger, parseConfig());
  const input = {
    url: "https://api.example.test/v2",
    method: "GET",
    headers: paymentHeader(2, 1, "https://api.example.test/v2"),
  };
  const intake = meter.begin(input);
  ledger.close();
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    expect(meter.begin(input)).toEqual({});
    expect(() => meter.complete(intake)).not.toThrow();
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining("without reliable budget enforcement"),
    );
  } finally {
    stderr.mockRestore();
  }
});
