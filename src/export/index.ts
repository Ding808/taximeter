import { countsAsSpend, deriveEvents, formatAmount, totals } from "../ledger/derive";
import type { PaymentEvent } from "../model";

function csvCell(value: string): string {
  const safe = /^[\s]*[=+@-]/.test(value) || /^[\t\r\n]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

/** `amount` is the row's contribution to totals; the original proposal is separate. */
export function toCsv(input: PaymentEvent[]): string {
  const columns = [
    "id",
    "ts",
    "rail",
    "status",
    "settlementStatus",
    "amount",
    "authorizedAmount",
    "asset",
    "network",
    "decimals",
    "decimalsKnown",
    "assetSymbol",
    "payTo",
    "payer",
    "resource",
    "host",
    "taskId",
    "agentId",
    "txHash",
    "reason",
  ];
  const rows = deriveEvents(input).map((event) => [
    event.id,
    event.ts,
    event.rail,
    event.status,
    event.settlementStatus,
    countsAsSpend(event) ? event.amount : "0",
    event.amount,
    event.asset.toLowerCase(),
    event.network,
    event.decimals.toString(),
    event.decimalsKnown.toString(),
    event.assetSymbol ?? "",
    event.payTo,
    event.payer ?? "",
    event.resource,
    event.host,
    event.taskId ?? "",
    event.agentId ?? "",
    event.txHash ?? "",
    event.reason ?? "",
  ]);
  return `${[columns, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

export function toJson(input: PaymentEvent[]): string {
  const events = deriveEvents(input);
  return `${JSON.stringify({ events, totals: totals(events) }, null, 2)}\n`;
}

function html(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function toInvoice(input: PaymentEvent[]): string {
  const events = deriveEvents(input);
  const totalRows = totals(events)
    .map(
      (total) =>
        `<tr><td>${html(total.assetSymbol ?? total.asset)}<small>${html(total.network)} · ${html(total.asset)}</small></td><td class="number">${total.decimalsKnown ? formatAmount(total.amount, total.decimals) : `${total.amount} atomic units`}</td><td class="number">${total.unknownAmount}</td></tr>`,
    )
    .join("");
  const rows = events
    .map(
      (event) =>
        `<tr><td>${html(event.ts)}</td><td>${html(event.taskId ?? "Unattributed")}</td><td>${html(event.host)}</td><td>${html(event.status === "blocked" ? "Blocked" : event.settlementStatus)}</td><td class="number">${countsAsSpend(event) ? event.amount : "0"}</td><td>${html(event.network)} / ${html(event.asset)}</td></tr>`,
    )
    .join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Taximeter payment statement</title><style>
body{font:14px Arial,Helvetica,sans-serif;color:#182b27;background:#fff;margin:40px}h1{font-size:30px;font-weight:500}p,small{color:#4a5e58}small{display:block;font-size:11px;overflow-wrap:anywhere}table{border-collapse:collapse;width:100%;margin:24px 0}th,td{text-align:left;vertical-align:top;padding:8px 4px;border-bottom:1px solid #d5e0db;font-size:12px;overflow-wrap:anywhere}th{font-weight:600}.number{text-align:right;font-family:Consolas,monospace;font-variant-numeric:tabular-nums}@media print{body{margin:12mm}thead{display:table-header-group}}
</style></head><body><h1>Taximeter payment statement</h1><p>Local ledger · ${events.length} recorded events</p><p>Amounts remain separate by network and asset. Totals include unresolved authorizations; settlement is reported by the upstream and is not independently verified.</p><table><thead><tr><th>Asset / network</th><th>Total</th><th>Uncertain (atomic units)</th></tr></thead><tbody>${totalRows || '<tr><td colspan="3">No payments recorded.</td></tr>'}</tbody></table><table><thead><tr><th>Observed (UTC)</th><th>Task</th><th>Host</th><th>State</th><th>Counted amount (atomic units)</th><th>Network / asset</th></tr></thead><tbody>${rows}</tbody></table><p>Blocked and explicitly failed payments contribute zero. Taximeter never holds funds, signs a payment, or settles a transaction.</p></body></html>\n`;
}
