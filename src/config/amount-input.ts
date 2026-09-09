import { z } from "zod";
import { assetMetadata, knownAssets } from "../assets";
import { amountSchema } from "../model";

function metadataForSelector(selector: string, network?: string) {
  const registry = knownAssets();
  const bySymbol = registry.find((entry) => entry.assetSymbol === selector);
  if (bySymbol) return bySymbol;
  if (network) return assetMetadata(network, selector);
  const entries = registry.filter((entry) => entry.asset.toLowerCase() === selector.toLowerCase());
  const first = entries[0];
  if (
    first &&
    entries.every(
      (entry) => entry.decimals === first.decimals && entry.assetSymbol === first.assetSymbol,
    )
  )
    return first;
  return { decimals: 0, decimalsKnown: false, assetSymbol: undefined };
}

export function knownAmountSymbols(): string[] {
  return [
    ...new Set(knownAssets().flatMap((entry) => (entry.assetSymbol ? [entry.assetSymbol] : []))),
  ].sort();
}

/** Bare integers are atomic units; decimal input always needs an explicit known symbol. */
export function parseAmountInput(input: string, selector = "USDC", network?: string): string {
  const text = z.string().min(1).parse(input).trim();
  if (/^[0-9]+$/.test(text)) return amountSchema.parse(text);
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?\s*([a-zA-Z][a-zA-Z0-9]*)$/.exec(text);
  if (!match)
    throw new Error("Use an exact atomic integer or an amount with a known symbol, such as 5USDC.");
  const symbol = match[3]?.toUpperCase();
  const metadata = knownAssets().find((entry) => entry.assetSymbol === symbol);
  if (!metadata) {
    throw new Error(
      `Unknown asset symbol ${symbol}. Known symbols: ${knownAmountSymbols().join(", ")}. An exact atomic integer is always accepted.`,
    );
  }
  const selected = metadataForSelector(selector, network);
  if (!selected.decimalsKnown || selected.assetSymbol !== symbol) {
    throw new Error(
      `Amount unit ${symbol} does not match configured asset ${selector}. Change the asset explicitly or use an exact atomic integer.`,
    );
  }
  const fraction = match[2] ?? "";
  if (fraction.length > metadata.decimals)
    throw new Error(
      `${symbol} supports at most ${metadata.decimals} decimal places; no rounding is performed.`,
    );
  const scale = 10n ** BigInt(metadata.decimals);
  const units =
    BigInt(match[1] ?? "0") * scale + BigInt(fraction.padEnd(metadata.decimals, "0") || "0");
  return amountSchema.parse(units.toString());
}

/** Only registry metadata may turn atomic units into a human-readable quantity. */
export function formatAmount(amount: string, selector: string, network?: string): string {
  const atomic = amountSchema.parse(amount);
  const metadata = metadataForSelector(selector, network);
  if (!metadata.decimalsKnown || !metadata.assetSymbol) return `${atomic} atomic units`;
  const digits = atomic.padStart(metadata.decimals + 1, "0");
  const whole = metadata.decimals ? digits.slice(0, -metadata.decimals) : digits;
  const fraction = metadata.decimals ? digits.slice(-metadata.decimals).replace(/0+$/, "") : "";
  return `${whole}${fraction ? `.${fraction}` : ""} ${metadata.assetSymbol}`;
}
