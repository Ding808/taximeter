import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { Total } from "../src/ledger/derive";
import { type DashboardState, dashboardStateSchema } from "../src/server/schema";
import { version } from "../src/version";
import { Dashboard } from "../ui/App";
import { amountText, assetIdentity, hourlySeries, percentOf } from "../ui/helpers";
import { event } from "./helpers";

function total(overrides: Partial<Total> = {}): Total {
  return {
    network: "eip155:8453",
    asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    assetSymbol: "USDC",
    decimals: 6,
    decimalsKnown: true,
    amount: "2000000",
    confirmedAmount: "1000000",
    unknownAmount: "1000000",
    ...overrides,
  };
}

function state(overrides: Partial<DashboardState> = {}): DashboardState {
  return dashboardStateSchema.parse({
    version,
    generatedAt: "2026-09-08T12:00:00.000Z",
    totalEvents: 0,
    blockedEvents: 0,
    unknownEvents: 0,
    totals: [],
    events: [],
    diagnostics: [],
    groups: { task: [], agent: [], host: [] },
    hours: [],
    globalBudget: { amount: "100000000", asset: "USDC", window: "24h" },
    budgets: [],
    proxy: { port: 9123, upstream: "https://upstream.example.test" },
    ...overrides,
  });
}

function render(
  input: DashboardState,
  initialView: "now" | "task" | "agent" | "host" | "timeline" | "export" = "now",
) {
  return renderToStaticMarkup(createElement(Dashboard, { state: input, initialView }));
}

describe("dashboard communicates the real ledger state", () => {
  test("empty state identifies the configured local proxy and its HTTPS limit", () => {
    const html = render(state());
    expect(html).toContain("Your next payment starts the ledger.");
    expect(html).toContain("http://127.0.0.1:9123");
    expect(html).toContain("https://upstream.example.test");
    expect(html).toContain("HTTPS CONNECT passes through unmetered");
    expect(html).toContain("No payments recorded");
    expect(html).not.toContain("fonts.googleapis.com");
  });

  test("huge amounts retain every digit in rendered spend", () => {
    const value = "900719925474099312345678";
    const html = render(
      state({ totals: [total({ amount: value, unknownAmount: value, confirmedAmount: "0" })] }),
    );
    expect(html).toContain("900719925474099312.345678");
    expect(html).not.toContain("9.007199");
  });

  test("the active window's spend and the lifetime ledger total remain distinct", () => {
    const current = total({ amount: "8000000" });
    const html = render(
      state({
        totals: [current],
        budgets: [
          {
            network: current.network,
            asset: current.asset,
            limit: "10000000",
            spent: "2000000",
            remaining: "8000000",
            window: "24h",
          },
        ],
      }),
    );
    expect(html).toContain("BUDGET SPEND · 24H");
    expect(html).toContain("2.000000");
    expect(html).toContain("Ledger total");
    expect(html).toContain("8.000000");
    expect(html).toContain("20.00% of the active global budget used");
  });

  test("different networks are separate choices rather than a combined USDC figure", () => {
    const html = render(
      state({
        totals: [
          total({ amount: "2000000" }),
          total({
            network: "eip155:84532",
            asset: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
            amount: "7000000",
          }),
        ],
      }),
    );
    expect(html).toContain("USDC · Base");
    expect(html).toContain("USDC · Base Sepolia");
    expect(html).toContain("Each network and token has its own balance.");
    expect(html).not.toContain("9.000000");
  });

  test("unknown decimals are labeled as atomic units", () => {
    const unknown = total({
      asset: "0x1111111111111111111111111111111111111111",
      assetSymbol: undefined,
      decimals: 0,
      decimalsKnown: false,
      amount: "123456789",
    });
    const html = render(state({ totals: [unknown] }));
    expect(html).toContain("123456789 atomic units");
    expect(html).not.toContain("123.456789");
  });

  test("blocked, settled, and unknown outcomes have explicit text labels", () => {
    const html = render(
      state({
        totalEvents: 3,
        blockedEvents: 1,
        unknownEvents: 1,
        events: [
          event({ status: "blocked", reason: "Budget exhausted" }),
          event({ settlementStatus: "confirmed" }),
          event({ settlementStatus: "unknown" }),
        ],
        totals: [total()],
      }),
    );
    expect(html).toContain("Blocked");
    expect(html).toContain("Settled");
    expect(html).toContain("Unknown");
    expect(html).toContain("Settled means reported by the upstream");
    expect(html).toContain("Blocked attempts do not count as spend");
  });

  test("unattributed spend remains visible in grouped tables", () => {
    const html = render(
      state({
        totals: [total()],
        groups: { task: [{ ...total(), key: null }], agent: [], host: [] },
      }),
      "task",
    );
    expect(html).toContain("Unattributed");
    expect(html).toContain("2.000000");
  });

  test("hostile attribution strings are escaped instead of becoming executable markup", () => {
    const name = '<script>alert("ledger")</script>';
    const html = render(
      state({
        totals: [total()],
        groups: { task: [{ ...total(), key: name }], agent: [], host: [] },
      }),
      "task",
    );
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });

  test("lost connections retain the last data with a visible warning", () => {
    const html = renderToStaticMarkup(
      createElement(Dashboard, { state: state({ totals: [total()] }), connection: "offline" }),
    );
    expect(html).toContain("Connection lost");
    expect(html).toContain("Showing the last update");
    expect(html).toContain("2.000000");
  });

  test("all export formats use local download endpoints with an exact preview", () => {
    const html = render(state({ totalEvents: 2, totals: [total()] }), "export");
    expect(html).toContain("/api/export?format=csv");
    expect(html).toContain("/api/export?format=json");
    expect(html).toContain("/api/export?format=invoice");
    expect(html).toContain("STATEMENT PREVIEW");
    expect(html).toContain("2000000");
    expect(html).toContain("Printable HTML");
  });

  test("empty timeline renders bounded SVG frames without invalid coordinates", () => {
    const html = render(state(), "timeline");
    expect(html).toContain("Cumulative spend");
    expect(html).toContain("Spend per hour");
    expect(html).toContain('viewBox="0 0 1000 224"');
    expect(html).not.toMatch(/NaN|Infinity/);
  });
});

describe("exact display and chart arithmetic", () => {
  test("display formatting keeps unknown decimals explicit", () => {
    expect(amountText("7", { decimals: 6, decimalsKnown: true })).toBe("0.000007");
    expect(amountText("7", { decimals: 0, decimalsKnown: false })).toBe("7 atomic units");
  });

  test("budget meters round down fractional percentages without floating point", () => {
    expect(percentOf("1", "3")).toBe("33.33");
    expect(percentOf("900719925474099312345678", "1801439850948198624691356")).toBe("50.00");
    expect(percentOf("2", "1")).toBe("100.00");
    expect(percentOf("1", "0")).toBe("0");
  });

  test("timeline excludes another asset and preserves large cumulative totals", () => {
    const first = total({ amount: "900719925474099312345678" });
    const other = total({
      asset: "0x1111111111111111111111111111111111111111",
      amount: "999999999999999999999999",
    });
    const data = hourlySeries(
      [
        { ts: "2026-09-08T11:00:00.000Z", totals: [first, other] },
        { ts: "2026-09-08T12:00:00.000Z", totals: [total({ amount: "2" })] },
      ],
      assetIdentity(first),
    );
    expect(data.sum).toBe("900719925474099312345680");
    expect(data.maximum).toBe(first.amount);
    expect(data.series.at(-1)?.x).toBe("968");
    expect(data.series.at(-1)?.y).toBe("52");
    expect(data.points).not.toMatch(/NaN|Infinity/);
    expect(data.series.every((point) => BigInt(point.y) >= 0n && BigInt(point.y) <= 224n)).toBe(
      true,
    );
  });
});
