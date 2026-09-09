import { useEffect, useState } from "react";
import type { Total } from "../src/ledger/derive";
import { type DashboardState, dashboardStateSchema } from "../src/server/schema";
import {
  amountText,
  assetIdentity,
  assetName,
  clockText,
  hourlySeries,
  networkName,
  percentOf,
} from "./helpers";

type View = "now" | "task" | "agent" | "host" | "timeline" | "export";
type Connection = "live" | "connecting" | "offline";
type Event = DashboardState["events"][number];
const navigation: { view: View; label: string }[] = [
  { view: "now", label: "Now" },
  { view: "task", label: "By task" },
  { view: "agent", label: "By agent" },
  { view: "host", label: "By host" },
  { view: "timeline", label: "Timeline" },
  { view: "export", label: "Export" },
];

function Mark() {
  return (
    <span className="wordmark">
      <span className="mark" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      taximeter
    </span>
  );
}

function EmptyState({ state }: { state: DashboardState }) {
  const proxy = `http://127.0.0.1:${state.proxy.port}`;
  return (
    <section className="empty-state" aria-label="Getting started">
      <div className="empty-heading">
        <span className="eyebrow">READY WHEN YOU ARE</span>
        <h2>Your next payment starts the ledger.</h2>
        <p>
          Point your agent at the local proxy. Taximeter records each supported payment and checks
          its budget before the replay goes upstream.
        </p>
      </div>
      <div className="connection-instructions">
        <span className="eyebrow">YOUR LOCAL PROXY</span>
        <code>{proxy}</code>
        <p>
          {state.proxy.upstream ? (
            <>
              Requests forward to <strong>{state.proxy.upstream}</strong>.
            </>
          ) : (
            <>
              Use this address with an HTTP-proxy-aware client. For an explicit API base URL,
              restart with <code>--upstream</code> set to your API.
            </>
          )}
        </p>
        <p className="connection-limit">
          HTTPS CONNECT passes through unmetered. Use an explicit upstream or the{" "}
          <code>withMeter</code> SDK to inspect HTTPS payments.
        </p>
      </div>
      <div className="empty-footer">
        <span>No payments recorded</span>
        <span>No keys. No custody. Everything stays local.</span>
      </div>
    </section>
  );
}

function EventStatus({ event }: { event: Event }) {
  const label =
    event.status === "blocked"
      ? "Blocked"
      : event.settlementStatus === "confirmed"
        ? "Settled"
        : event.settlementStatus === "failed"
          ? "Failed"
          : "Unknown";
  const style = event.status === "blocked" ? "blocked" : event.settlementStatus;
  return (
    <span
      className={`event-status status-${style}`}
      title={
        event.reason ??
        (label === "Settled"
          ? "Settlement reported by the upstream"
          : label === "Unknown"
            ? "Settlement unknown; budget remains reserved"
            : undefined)
      }
    >
      {label}
    </span>
  );
}

function Events({ state }: { state: DashboardState }) {
  return (
    <section className="ledger-section">
      <div className="section-heading">
        <div>
          <h2>
            Live ledger <span className="muted">/ latest {state.events.length}</span>
          </h2>
        </div>
        <span className="table-note">All assets · times in UTC</span>
      </div>
      <div className="table-scroll">
        <table className="event-table">
          <thead>
            <tr>
              <th scope="col">Time</th>
              <th scope="col">Resource</th>
              <th scope="col">Task / agent</th>
              <th scope="col">Network</th>
              <th scope="col" className="numeric">
                Amount
              </th>
              <th scope="col">Asset</th>
              <th scope="col" className="status-cell">
                Status
              </th>
            </tr>
          </thead>
          <tbody>
            {state.events.map((event) => (
              <tr key={event.id} className={event.status === "blocked" ? "blocked-row" : undefined}>
                <td className="mono time-cell" title={event.ts}>
                  {clockText(event.ts)}
                </td>
                <td className="resource-cell">
                  <a href={event.resource} target="_blank" rel="noreferrer" title={event.resource}>
                    {event.host}
                  </a>
                </td>
                <td
                  className="attribution-cell"
                  title={`Task: ${event.taskId ?? "Unattributed"}\nAgent: ${event.agentId ?? "Unattributed"}`}
                >
                  <span>{event.taskId ?? "Unattributed"}</span>
                  {event.agentId && <span className="secondary-label"> / {event.agentId}</span>}
                </td>
                <td className="network-cell">{networkName(event.network)}</td>
                <td className="numeric mono" title={`${event.amount} atomic units`}>
                  {amountText(event.amount, event)}
                </td>
                <td title={`${event.network} / ${event.asset}`} className="asset-cell">
                  {assetName(event)}
                </td>
                <td className="status-cell">
                  <EventStatus event={event} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="ledger-footnote">
        Settled means reported by the upstream. Unknown settlement remains reserved against the
        budget. Blocked attempts do not count as spend.
      </p>
    </section>
  );
}

function BudgetHero({ state, active }: { state: DashboardState; active: Total | undefined }) {
  const budget = active
    ? state.budgets.find((item) => assetIdentity(item) === assetIdentity(active))
    : undefined;
  const metadata = active ?? {
    decimals: state.globalBudget?.asset === "USDC" ? 6 : 0,
    decimalsKnown: state.globalBudget?.asset === "USDC",
  };
  const displayed = budget?.spent ?? active?.amount ?? "0";
  const limit = budget?.limit ?? (!active ? state.globalBudget?.amount : undefined) ?? null;
  const count = budget?.count ?? "0";
  const countLimit =
    budget?.countLimit ??
    (!active ? state.globalBudget?.maxPayments?.toString() : undefined) ??
    null;
  const countRemaining = budget?.countRemaining ?? countLimit;
  const window = budget?.window ?? (!active ? state.globalBudget?.window : undefined);
  const remaining = budget?.remaining ?? limit;
  const percentage = limit ? percentOf(displayed, limit) : "0";
  const countPercentage = countLimit ? percentOf(count, countLimit) : "0";
  return (
    <section className="budget-hero" aria-label="Current spend and budget">
      <div className="hero-value">
        <span className="eyebrow">
          {budget || (!active && (limit !== null || countLimit !== null))
            ? `BUDGET SPEND${window ? ` · ${window.toUpperCase()}` : ""}`
            : "LEDGER TOTAL · ALL TIME"}
        </span>
        <div className="hero-number mono" title={`${displayed} atomic units`}>
          {amountText(displayed, metadata)}
          <span className="hero-unit">
            {active?.assetSymbol ?? (!active ? state.globalBudget?.asset : undefined)}
          </span>
        </div>
        <p>
          {active
            ? `${networkName(active.network)} · ${active.asset}`
            : "Waiting for the first supported payment"}
        </p>
      </div>
      <div className="budget-detail">
        {(limit !== null || countLimit === null) && (
          <>
            <div className="budget-caption">
              <span>{limit ? "Active global budget" : "No global budget for this asset"}</span>
              <span className="mono">
                {limit
                  ? `${amountText(limit, metadata)} ${active?.assetSymbol ?? state.globalBudget?.asset ?? ""}`
                  : "Uncapped"}
              </span>
            </div>
            <div
              className="budget-track"
              role="img"
              aria-label={
                limit ? `${percentage}% of the active global budget used` : "No active budget meter"
              }
            >
              <span style={{ width: `${percentage}%` }} />
            </div>
            <div className="budget-caption below">
              <span>
                {limit && remaining ? (
                  <>
                    <strong className="mono">{amountText(remaining, metadata)}</strong> remaining
                  </>
                ) : (
                  "Asset balances are never combined."
                )}
              </span>
              <span>{window ? `Rolling ${window}` : "All time"}</span>
            </div>
          </>
        )}
        {countLimit !== null && (
          <section
            aria-label="Global payment-count budget"
            style={{ marginTop: limit !== null ? "16px" : undefined }}
          >
            <div className="budget-caption">
              <span>{limit === null ? "Active global payment-count budget" : "Payment count"}</span>
              <span className="mono">
                {count} / {countLimit} payments
              </span>
            </div>
            <div
              className="budget-track"
              role="img"
              aria-label={`${countPercentage}% of the active global payment-count budget used`}
            >
              <span style={{ width: `${countPercentage}%` }} />
            </div>
            <div className="budget-caption below">
              <span>
                <strong className="mono">{countRemaining}</strong>{" "}
                {countRemaining === "1" ? "payment" : "payments"} remaining
              </span>
              <span>{window ? `Rolling ${window}` : "All time"}</span>
            </div>
          </section>
        )}
        <p className="scope-note">Each network and token has its own balance.</p>
      </div>
    </section>
  );
}

function TotalsStrip({ state, active }: { state: DashboardState; active: Total | undefined }) {
  return (
    <div className="totals-strip">
      <span>
        Ledger total{" "}
        <strong className="mono">{active ? amountText(active.amount, active) : "0"}</strong>
      </span>
      <span>
        Reported settled{" "}
        <strong className="mono">
          {active ? amountText(active.confirmedAmount, active) : "0"}
        </strong>
      </span>
      <span>
        Settlement unknown{" "}
        <strong className="mono">{active ? amountText(active.unknownAmount, active) : "0"}</strong>
      </span>
      <span className="blocked-count">
        Blocked <strong className="mono">{state.blockedEvents}</strong>
      </span>
    </div>
  );
}

function Groups({
  state,
  active,
  field,
}: {
  state: DashboardState;
  active: Total | undefined;
  field: "task" | "agent" | "host";
}) {
  const [sort, setSort] = useState<"name" | "highest" | "lowest">("highest");
  const rows = state.groups[field].filter(
    (row) => active && assetIdentity(row) === assetIdentity(active),
  );
  const sorted = [...rows].sort((left, right) =>
    sort === "name"
      ? (left.key ?? "Unattributed").localeCompare(right.key ?? "Unattributed")
      : BigInt(left.amount) === BigInt(right.amount)
        ? (left.key ?? "").localeCompare(right.key ?? "")
        : (BigInt(left.amount) > BigInt(right.amount) ? -1 : 1) * (sort === "lowest" ? -1 : 1),
  );
  const maximum = rows
    .reduce((value, row) => (BigInt(row.amount) > value ? BigInt(row.amount) : value), 0n)
    .toString();
  return (
    <section className="group-section">
      <div className="section-heading">
        <h2>Spend by {field}</h2>
        <span className="table-note">
          All time · {rows.length} {field}
          {rows.length === 1 ? "" : "s"}
        </span>
      </div>
      {rows.length ? (
        <div className="table-scroll">
          <table className="group-table">
            <thead>
              <tr>
                <th scope="col">
                  <button type="button" onClick={() => setSort("name")}>
                    {field === "task" ? "Task" : field === "agent" ? "Agent" : "Host"}{" "}
                    {sort === "name" ? "↓" : "↕"}
                  </button>
                </th>
                <th scope="col">Proportion</th>
                <th scope="col" className="numeric">
                  <button
                    type="button"
                    onClick={() => setSort(sort === "highest" ? "lowest" : "highest")}
                  >
                    Spend {sort === "highest" ? "↓" : sort === "lowest" ? "↑" : "↕"}
                  </button>
                </th>
                <th scope="col" className="numeric">
                  Unknown
                </th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((row) => (
                <tr key={`${row.key}/${assetIdentity(row)}`}>
                  <td className="group-name">{row.key ?? "Unattributed"}</td>
                  <td className="group-bar-cell">
                    <div className="group-bar">
                      <span style={{ width: `${percentOf(row.amount, maximum)}%` }} />
                    </div>
                  </td>
                  <td className="numeric mono">
                    {amountText(row.amount, row)} <span className="muted">{row.assetSymbol}</span>
                  </td>
                  <td className="numeric mono muted">{amountText(row.unknownAmount, row)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="quiet-empty">
          <h3>No spend attributed yet.</h3>
          <p>Payments will appear here as your agent uses the proxy or SDK.</p>
        </div>
      )}
      <p className="ledger-footnote">
        Bars compare {active ? assetName(active) : "one asset"} on{" "}
        {active ? networkName(active.network) : "one network"} only. Missing labels appear as
        Unattributed.
      </p>
    </section>
  );
}

function Timeline({ state, active }: { state: DashboardState; active: Total | undefined }) {
  const data = hourlySeries(state.hours, active ? assetIdentity(active) : "");
  const first = data.series[0];
  const last = data.series.at(-1);
  const label = active ? `${amountText(data.sum, active)} ${active.assetSymbol ?? ""}` : "0";
  const peak = active ? `${amountText(data.maximum, active)} ${active.assetSymbol ?? ""}` : "0";
  return (
    <section className="timeline-section">
      <div className="section-heading">
        <h2>Spend over time</h2>
        <span className="table-note">Trailing 24 hours · UTC</span>
      </div>
      <div className="chart-heading">
        <h3>Cumulative spend</h3>
        <span className="mono">{label}</span>
      </div>
      <div className="chart-scroll">
        <svg
          className="chart"
          viewBox="0 0 1000 224"
          role="img"
          aria-label={`Cumulative spend over the trailing 24 hours: ${label}`}
        >
          <title>Cumulative spend over the trailing 24 hours</title>
          <line x1="32" x2="968" y1="184" y2="184" className="chart-rule" />
          <line x1="32" x2="968" y1="118" y2="118" className="chart-grid" />
          <line x1="32" x2="968" y1="52" y2="52" className="chart-grid" />
          <text x="32" y="26">
            0
          </text>
          <text x="968" y="26" textAnchor="end">
            {label}
          </text>
          {data.points && <polyline points={data.points} className="sparkline" />}
          {last && <circle cx={last.x} cy={last.y} r="4" className="chart-dot" />}
          <text x="32" y="213">
            {first ? `${first.ts.slice(5, 10)} ${clockText(first.ts).slice(0, 5)}` : "Start"}
          </text>
          <text x="968" y="213" textAnchor="end">
            {last ? `${last.ts.slice(5, 10)} ${clockText(last.ts).slice(0, 5)}` : "Now"}
          </text>
        </svg>
      </div>
      <div className="chart-heading hourly-heading">
        <h3>Spend per hour</h3>
        <span className="muted">
          Peak <strong className="mono">{peak}</strong>
        </span>
      </div>
      <div className="chart-scroll">
        <svg
          className="chart hourly-chart"
          viewBox="0 0 1000 176"
          role="img"
          aria-label={`Hourly spend for the trailing 24 hours. Peak: ${peak}`}
        >
          <title>Spend per hour</title>
          <line x1="32" x2="968" y1="138" y2="138" className="chart-rule" />
          {data.series.map((row) => (
            <rect
              key={row.ts}
              x={row.barX}
              y={row.barY}
              width={row.barWidth}
              height={row.barHeight}
              className="hour-bar"
            >
              <title>
                {clockText(row.ts).slice(0, 5)} UTC: {active ? amountText(row.amount, active) : "0"}
              </title>
            </rect>
          ))}
          <text x="32" y="165">
            {first ? `${clockText(first.ts).slice(0, 5)} UTC` : "Start"}
          </text>
          <text x="968" y="165" textAnchor="end">
            {last ? `${clockText(last.ts).slice(0, 5)} UTC` : "Now"}
          </text>
        </svg>
      </div>
      <p className="ledger-footnote">
        Includes reported settled and unresolved authorizations. Blocked attempts and known failed
        settlements are excluded. Hourly totals use the payment's latest attempt time.
      </p>
    </section>
  );
}

function ExportView({ state }: { state: DashboardState }) {
  return (
    <section className="export-section">
      <div className="section-heading">
        <h2>A statement you can keep.</h2>
        <span className="table-note">All events · all assets</span>
      </div>
      <p className="section-intro">
        Download the local ledger with exact amounts and explicit settlement status. Assets and
        networks stay separate in every format.
      </p>
      <div className="export-options">
        <a className="export-option" href="/api/export?format=csv" download>
          <span className="eyebrow">FOR SPREADSHEETS</span>
          <strong>
            CSV{" "}
            <span className="download-arrow" aria-hidden="true">
              ↗
            </span>
          </strong>
          <span>One event per row. Atomic integer amounts.</span>
          <span className="download-label">Download CSV</span>
        </a>
        <a className="export-option" href="/api/export?format=json" download>
          <span className="eyebrow">FOR YOUR TOOLS</span>
          <strong>
            JSON{" "}
            <span className="download-arrow" aria-hidden="true">
              ↗
            </span>
          </strong>
          <span>Event history, totals, and audit payloads.</span>
          <span className="download-label">Download JSON</span>
        </a>
        <a className="export-option" href="/api/export?format=invoice" download>
          <span className="eyebrow">FOR YOUR RECORDS</span>
          <strong>
            Invoice{" "}
            <span className="download-arrow" aria-hidden="true">
              ↗
            </span>
          </strong>
          <span>Printable HTML. Open it to save as PDF.</span>
          <span className="download-label">Download invoice</span>
        </a>
      </div>
      <div className="statement-preview">
        <div className="preview-heading">
          <Mark />
          <span>STATEMENT PREVIEW</span>
        </div>
        <div className="preview-summary">
          <span>
            Ledger entries <strong className="mono">{state.totalEvents}</strong>
          </span>
          <span>
            Blocked attempts <strong className="mono">{state.blockedEvents}</strong>
          </span>
          <span>
            Unknown settlement <strong className="mono">{state.unknownEvents}</strong>
          </span>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Asset / network</th>
                <th scope="col" className="numeric">
                  Ledger total
                </th>
                <th scope="col" className="numeric">
                  Atomic units
                </th>
              </tr>
            </thead>
            <tbody>
              {state.totals.length ? (
                state.totals.map((total) => (
                  <tr key={assetIdentity(total)}>
                    <td>
                      <strong>{assetName(total)}</strong>
                      <span className="secondary-label"> · {networkName(total.network)}</span>
                      <small className="contract-address">{total.asset}</small>
                    </td>
                    <td className="numeric mono">{amountText(total.amount, total)}</td>
                    <td className="numeric mono">{total.amount}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={3}>No payments recorded.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="ledger-footnote">
          This preview shows totals. Downloads contain the full local ledger, including blocked
          attempts. The invoice is a spending record, not proof of on-chain settlement.
        </p>
      </div>
    </section>
  );
}

export function Dashboard({
  state,
  connection = "live",
  initialView = "now",
}: {
  state: DashboardState;
  connection?: Connection;
  initialView?: View;
}) {
  const [view, setView] = useState<View>(initialView);
  const [selected, setSelected] = useState("");
  const active = state.totals.find((total) => assetIdentity(total) === selected) ?? state.totals[0];
  const title = navigation.find((item) => item.view === view)?.label ?? "Now";
  return (
    <div className="app-shell">
      <header className="masthead">
        <div className="brand">
          <Mark />
          <span className="brand-description">A taximeter for your AI agents.</span>
        </div>
        <div className={`connection-state connection-${connection}`} role="status">
          <span className="live-dot" aria-hidden="true" />
          {connection === "live"
            ? "Local · live"
            : connection === "offline"
              ? "Connection lost"
              : "Connecting"}
        </div>
      </header>
      <nav className="navigation" aria-label="Ledger views">
        {navigation.map((item) => (
          <button
            type="button"
            key={item.view}
            aria-current={item.view === view ? "page" : undefined}
            onClick={() => setView(item.view)}
          >
            {item.label}
          </button>
        ))}
        <span className="nav-date">
          {new Date(state.generatedAt).toLocaleDateString("en-GB", {
            day: "2-digit",
            month: "short",
            year: "numeric",
            timeZone: "UTC",
          })}
        </span>
      </nav>
      <main>
        <div className="page-heading">
          <div>
            <span className="eyebrow">YOUR LOCAL LEDGER</span>
            <h1>{title === "Now" ? "Every small charge. In view." : title}</h1>
          </div>
          {view !== "export" && state.totals.length > 0 && (
            <div className="asset-selector">
              <label htmlFor="asset-selector">Balance</label>
              <select
                id="asset-selector"
                value={active ? assetIdentity(active) : ""}
                onChange={(event) => setSelected(event.currentTarget.value)}
              >
                {state.totals.map((total) => (
                  <option key={assetIdentity(total)} value={assetIdentity(total)}>
                    {assetName(total)} · {networkName(total.network)}
                    {state.totals.some(
                      (other) =>
                        other !== total &&
                        other.network === total.network &&
                        other.assetSymbol === total.assetSymbol,
                    )
                      ? ` · ${total.asset.slice(0, 8)}…`
                      : ""}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
        {connection === "offline" && (
          <p className="connection-warning" role="alert">
            The local meter is unavailable. Showing the last update from{" "}
            {clockText(state.generatedAt)} UTC. Reconnecting automatically.
          </p>
        )}
        {view === "now" ? (
          <>
            <BudgetHero state={state} active={active} />
            <TotalsStrip state={state} active={active} />
            {state.events.length ? <Events state={state} /> : <EmptyState state={state} />}
          </>
        ) : view === "task" || view === "agent" || view === "host" ? (
          <Groups key={view} state={state} active={active} field={view} />
        ) : view === "timeline" ? (
          <Timeline state={state} active={active} />
        ) : (
          <ExportView state={state} />
        )}
        {state.diagnostics.length > 0 && (
          <details className="diagnostics">
            <summary>
              Diagnostics <span className="mono">{state.diagnostics.length}</span>
              <span className="muted"> · recent observations</span>
            </summary>
            <ul>
              {state.diagnostics.map((diagnostic) => (
                <li key={diagnostic.id}>
                  <span className="mono">{clockText(diagnostic.ts)}</span>
                  <strong>{diagnostic.code.replaceAll("_", " ")}</strong>
                  <span>{diagnostic.message}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
        <footer className="page-footer">
          <span>Local ledger · x402 exact EIP-3009</span>
          <span>Read-only dashboard</span>
          <span>HTTPS CONNECT is unmetered · updated {clockText(state.generatedAt)} UTC</span>
          <span className="mono">v{state.version}</span>
        </footer>
      </main>
    </div>
  );
}

export default function App() {
  const [state, setState] = useState<DashboardState | null>(null);
  const [connection, setConnection] = useState<Connection>("connecting");
  useEffect(() => {
    const abort = new AbortController();
    let pending = false;
    async function refresh() {
      if (pending) return;
      pending = true;
      try {
        const response = await fetch("/api/summary", { signal: abort.signal, cache: "no-store" });
        if (!response.ok) throw new Error("Local meter unavailable");
        const next = dashboardStateSchema.parse(await response.json());
        if (!abort.signal.aborted) {
          setState(next);
          setConnection("live");
        }
      } catch {
        if (!abort.signal.aborted) setConnection("offline");
      } finally {
        pending = false;
      }
    }
    void refresh();
    const interval = setInterval(() => {
      void refresh();
    }, 1000);
    return () => {
      clearInterval(interval);
      abort.abort();
    };
  }, []);
  return state ? (
    <Dashboard state={state} connection={connection} />
  ) : (
    <div className="loading-shell">
      <Mark />
      <span className="eyebrow">YOUR LOCAL LEDGER</span>
      <h1>{connection === "offline" ? "The meter is not responding." : "Opening your ledger."}</h1>
      <p>
        {connection === "offline"
          ? "Keep Taximeter running, then leave this page open. It reconnects automatically."
          : "Reading the local ledger. Your payment history stays on this machine."}
      </p>
      <code>taximeter start</code>
    </div>
  );
}
