import { afterEach, expect, test, vi } from "vitest";
import { parseConfig } from "../src/config";
import { Ledger } from "../src/ledger/store";
import { paymentHeader } from "./fixtures/upstream";

afterEach(() => vi.restoreAllMocks());

test("blocked hints are shared across meter instances and printed once per reason", async () => {
  vi.resetModules();
  const { Meter } = await import("../src/core");
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const first = new Ledger(":memory:");
  const second = new Ledger(":memory:");
  const resource = "http://api.example.test/data";
  try {
    for (const ledger of [first, second]) {
      const amount = new Meter(ledger, parseConfig({ policy: { maxSinglePayment: "0" } }));
      const count = new Meter(ledger, parseConfig({ budgets: { global: { maxPayments: 1 } } }));
      for (const nonce of [1, 2, 3])
        expect(
          amount.begin({ url: resource, method: "GET", headers: paymentHeader(2, nonce, resource) })
            .body?.reason,
        ).toBe("max_single_payment");
      for (const nonce of [11, 12, 13])
        count.begin({ url: resource, method: "GET", headers: paymentHeader(2, nonce, resource) });
    }
    const output = stderr.mock.calls.map(([text]) => String(text)).join("");
    expect(output.match(/Taximeter blocked \(max_single_payment\)/g)).toHaveLength(1);
    expect(output.match(/Taximeter blocked \(global_payment_count\)/g)).toHaveLength(1);
    expect(output).toContain("taximeter config set policy.maxSinglePayment 7");
    expect(output).toContain("taximeter config set budgets.global.maxPayments 2");
  } finally {
    first.close();
    second.close();
  }
});

test("a closed or throwing stderr cannot turn a block into a forwarded payment", async () => {
  vi.resetModules();
  const { Meter } = await import("../src/core");
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => {
    throw new Error("Console closed");
  });
  const ledger = new Ledger(":memory:");
  const resource = "http://api.example.test/data";
  try {
    const meter = new Meter(ledger, parseConfig({ policy: { denyHosts: ["api.example.test"] } }));
    for (const nonce of [1, 2]) {
      const intake = meter.begin({
        url: resource,
        method: "GET",
        headers: paymentHeader(2, nonce, resource),
      });
      expect(intake.body).toMatchObject({
        reason: "host_denied",
        fix: 'taximeter config set policy.denyHosts "[]"',
      });
      expect(intake.payment).toBeUndefined();
    }
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(ledger.events().map((event) => event.status)).toEqual(["blocked", "blocked"]);
    expect(ledger.diagnostics()).toEqual([]);
  } finally {
    ledger.close();
  }
});
