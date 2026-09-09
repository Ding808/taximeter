import type { TaximeterConfig } from "../config";
import { formatAmount } from "./amount-input";
import type { ConfigDetails, ConfigLayer } from "./io";

function layerStatus(layer: ConfigLayer): string {
  if (!layer.supplied)
    return layer.path ? "[not found]" : layer.name === "explicit" ? "(not supplied)" : "(none)";
  const state = layer.contributed ? "in use" : layer.keys.length ? "overridden" : "empty";
  const partial =
    layer.contributed && layer.overriddenKeys.length
      ? `; overridden keys: ${layer.overriddenKeys.join(", ")}`
      : "";
  return `[${layer.path ? (layer.exists ? "exists, " : "candidate, ") : ""}${state}${partial}]`;
}

export function formatLayers(details: ConfigDetails): string {
  return [
    "Layers (highest priority first):",
    ...details.layers.map((layer) => {
      const value =
        layer.path ??
        (layer.name === "defaults"
          ? "built in"
          : layer.name === "environment"
            ? (layer.environmentVariables?.join(", ") ?? "")
            : layer.keys.join(", "));
      return `  ${layer.label.padEnd(13)}${value}${value ? "  " : ""}${layerStatus(layer)}`;
    }),
  ].join("\n");
}

export function formatEffectiveConfig(config: TaximeterConfig): string {
  const policy = config.policy;
  const amountDescription = (amount: string, asset: string, network?: string) => {
    const formatted = formatAmount(amount, asset, network);
    return formatted === `${amount} atomic units` ? formatted : `${amount}  (${formatted})`;
  };
  const list = (items: string[], meaning = "") =>
    items.length ? items.join(", ") : `(empty${meaning ? ` — ${meaning}` : ""})`;
  return [
    "Effective policy:",
    `  maxSinglePayment   ${policy.maxSinglePayment === null ? "disabled" : amountDescription(policy.maxSinglePayment, policy.maxSingleAsset)}`,
    `  maxSingleAsset     ${policy.maxSingleAsset}`,
    `  unknownAsset       ${policy.unknownAsset}`,
    `  allowHosts         ${list(policy.allowHosts, "all hosts allowed")}`,
    `  denyHosts          ${list(policy.denyHosts)}`,
    `  allowPayTo         ${list(policy.allowPayTo, "all recipients allowed")}`,
    "",
    "Effective budgets:",
    ...(["perTask", "perAgent", "global"] as const).map((scope) => {
      const budget = config.budgets[scope];
      if (!budget) return `  ${scope.padEnd(11)}disabled`;
      const amount =
        budget.amount === undefined
          ? "(no amount limit)"
          : amountDescription(budget.amount, budget.asset, budget.network);
      const count =
        budget.maxPayments === undefined
          ? "(no payment-count limit)"
          : `max ${budget.maxPayments} payments`;
      return `  ${scope.padEnd(11)}${amount}  ${budget.window ? `${budget.window}  ` : ""}${count}  asset ${budget.asset}${budget.network ? `  network ${budget.network}` : ""}`;
    }),
  ].join("\n");
}
