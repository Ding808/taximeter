import { formatAmount, type Total } from "../src/ledger/derive";
import type { DashboardState } from "../src/server/schema";

export function assetIdentity(asset: { network: string; asset: string }): string {
  return `${asset.network}/${asset.asset.toLowerCase()}`;
}

export function amountText(
  amount: string,
  metadata: { decimals: number; decimalsKnown: boolean },
): string {
  return metadata.decimalsKnown
    ? formatAmount(amount, metadata.decimals)
    : `${amount} atomic units`;
}

/** Scale only with integer arithmetic; the final CSS/SVG value remains a string. */
export function percentOf(amount: string, maximum: string): string {
  const limit = BigInt(maximum);
  if (limit <= 0n) return "0";
  const value = (BigInt(amount) * 10_000n) / limit;
  const clamped = value < 0n ? 0n : value > 10_000n ? 10_000n : value;
  return `${clamped / 100n}.${(clamped % 100n).toString().padStart(2, "0")}`;
}

export function networkName(network: string): string {
  if (network === "eip155:8453") return "Base";
  if (network === "eip155:84532") return "Base Sepolia";
  if (network === "eip155:1") return "Ethereum";
  return network;
}

export function assetName(asset: Pick<Total, "asset" | "assetSymbol">): string {
  return asset.assetSymbol ?? `${asset.asset.slice(0, 8)}…${asset.asset.slice(-6)}`;
}

export function clockText(ts: string): string {
  return new Date(ts).toISOString().slice(11, 19);
}

export function hourlySeries(hours: DashboardState["hours"], selected: string) {
  const values = hours.map((hour) => ({
    ts: hour.ts,
    amount: hour.totals.find((total) => assetIdentity(total) === selected)?.amount ?? "0",
  }));
  const sum = values.reduce((total, row) => total + BigInt(row.amount), 0n);
  const maximum = values.reduce(
    (total, row) => (BigInt(row.amount) > total ? BigInt(row.amount) : total),
    0n,
  );
  let cumulative = 0n;
  const divisor = BigInt(Math.max(values.length - 1, 1));
  const count = BigInt(Math.max(values.length, 1));
  const series = values.map((row, index) => {
    cumulative += BigInt(row.amount);
    return {
      ...row,
      x: (32n + (BigInt(index) * 936n) / divisor).toString(),
      y: (184n - (sum > 0n ? (cumulative * 132n) / sum : 0n)).toString(),
      barX: (32n + (BigInt(index) * 936n) / count).toString(),
      barWidth: (936n / count - 7n).toString(),
      barHeight: (maximum > 0n ? (BigInt(row.amount) * 106n) / maximum : 0n).toString(),
      barY: (138n - (maximum > 0n ? (BigInt(row.amount) * 106n) / maximum : 0n)).toString(),
    };
  });
  return {
    series,
    points: series.map((row) => `${row.x},${row.y}`).join(" "),
    sum: sum.toString(),
    maximum: maximum.toString(),
  };
}
