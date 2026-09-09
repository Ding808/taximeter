import { describe, expect, test } from "vitest";
import { parseConfig } from "../src/config";
import { Meter } from "../src/core";
import { Ledger } from "../src/ledger/store";
import { createProxy } from "../src/proxy";
import { fixtureUpstream, listen, paymentHeader, stop } from "./fixtures/upstream";

function countOnly(scope: "perTask" | "perAgent" | "global") {
  return parseConfig(
    {
      budgets: { perTask: null, perAgent: null, global: null },
      policy: { maxSinglePayment: null },
    },
    { budgets: { [scope]: { asset: "USDC", maxPayments: 1 } } },
  );
}

describe("resolved count-only configurations", () => {
  test.each(["perTask", "perAgent", "global"] as const)(
    "Meter preserves the resolved %s policy without reintroducing an amount limit",
    (scope) => {
      const ledger = new Ledger(":memory:");
      try {
        const config = countOnly(scope);
        const meter = new Meter(ledger, config);
        expect(meter.config).toEqual(config);
        const url = "https://api.example.test/v2";
        const input = {
          url,
          method: "GET",
          headers: paymentHeader(2, 1, url, "100000001"),
        };
        expect(meter.begin(input).payment?.amount).toBe("100000001");
        expect(meter.begin(input).body).toBeUndefined();
        expect(
          meter.begin({ ...input, headers: paymentHeader(2, 2, url, "100000001") }).body,
        ).toMatchObject({ budget: "1", spent: "1", remaining: "0" });
      } finally {
        ledger.close();
      }
    },
  );

  test("the HTTP proxy forwards above the default amount and blocks on count alone", async () => {
    const upstream = await fixtureUpstream();
    const ledger = new Ledger(":memory:");
    const proxy = createProxy({
      ledger,
      config: { ...countOnly("global"), upstream: upstream.url },
    });
    try {
      const port = await listen(proxy);
      const resource = `${upstream.url}/v2`;
      const first = await fetch(`http://127.0.0.1:${port}/v2`, {
        headers: paymentHeader(2, 1, resource, "100000001"),
      });
      expect(first.status).toBe(200);
      await first.arrayBuffer();
      const second = await fetch(`http://127.0.0.1:${port}/v2`, {
        headers: paymentHeader(2, 2, resource, "100000001"),
      });
      expect(second.status).toBe(402);
      expect(await second.json()).toMatchObject({
        reason: "global_payment_count",
        budget: "1",
        spent: "1",
        remaining: "0",
      });
      expect(upstream.requests).toHaveLength(1);
    } finally {
      if (proxy.listening) await stop(proxy);
      await upstream.close();
      ledger.close();
    }
  });
});
