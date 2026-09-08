import { expect, test } from "vitest";
import { fixtureUpstream, paymentHeader } from "./fixtures/upstream";

test.each([1, 2] as const)(
  "fixture speaks the documented v%s challenge and replay",
  async (version) => {
    const fixture = await fixtureUpstream();
    try {
      const url = `${fixture.url}/v${version}`;
      const challenge = await fetch(url);
      expect(challenge.status).toBe(402);
      expect(
        version === 2 ? challenge.headers.has("payment-required") : await challenge.text(),
      ).toBeTruthy();
      const paid = await fetch(url, { headers: paymentHeader(version, 1, url) });
      expect(paid.status).toBe(200);
      expect(paid.headers.has(version === 1 ? "x-payment-response" : "payment-response")).toBe(
        true,
      );
      expect(fixture.paid()).toBe(1);
    } finally {
      await fixture.close();
    }
  },
);
