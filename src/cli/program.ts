import { existsSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import { z } from "zod";
import { formatEffectiveConfig, formatLayers } from "../config/display";
import { configError } from "../config/edit";
import {
  type ConfigLoadOptions,
  loadConfig,
  loadConfigDetails,
  portInputSchema,
} from "../config/io";
import { toCsv, toInvoice, toJson } from "../export";
import { formatAmount, totals } from "../ledger/derive";
import { Ledger } from "../ledger/store";
import { httpUrlSchema, labelSchema } from "../model";
import { acquireLock, assertStopped, startServices } from "../server/lifecycle";
import { version } from "../version";
import { addConfigCommands, valueText } from "./config-command";
import { overridesSchema, startOverrides } from "./start-overrides";

const common = z.strictObject({ db: z.string().optional(), config: z.string().optional() });
const port = portInputSchema.optional();
const startFlags = common.extend({
  ...overridesSchema.shape,
  proxyPort: port,
  dashboardPort: port,
  upstream: httpUrlSchema.optional(),
});
const reportFlags = common.extend({
  json: z.boolean().optional(),
  task: labelSchema.optional(),
  agent: labelSchema.optional(),
  host: labelSchema.optional(),
});
const exportFlags = common
  .extend({
    json: z.string().min(1).optional(),
    csv: z.string().min(1).optional(),
    invoice: z.string().min(1).optional(),
  })
  .refine(
    (flags) => [flags.json, flags.csv, flags.invoice].filter(Boolean).length <= 1,
    "Choose one export format",
  );
const resetFlags = common.extend({ yes: z.boolean().default(false) });

function options(command: Command): Command {
  return command
    .option("--db <path>", "SQLite ledger path")
    .option("--config <path>", "Explicit config file");
}
export async function runCli(
  input: string[],
  output: (text: string) => void = (text) => process.stdout.write(text),
  sources: ConfigLoadOptions = {},
): Promise<void> {
  const sourceOptions = (flags: z.infer<typeof common>) => ({
    ...sources,
    configFile: flags.config ?? sources.configFile,
  });
  const configFrom = (flags: z.infer<typeof common>) =>
    loadConfig(flags.db ? { db: flags.db } : {}, sourceOptions(flags));
  const argv = z.array(z.string()).parse(input);
  const program = new Command()
    .name("taximeter")
    .description("A taximeter for your AI agents.")
    .version(version)
    .exitOverride();
  program.configureOutput({ writeOut: output, writeErr: (text) => process.stderr.write(text) });
  options(program.command("start").description("Start the local proxy and dashboard"))
    .option("--proxy-port <port>", "Proxy port (0 selects an available port)")
    .option("--dashboard-port <port>", "Dashboard port")
    .option("--upstream <url>", "Forward origin-form requests to this HTTP(S) upstream")
    .option(
      "--budget-global <amount>",
      "Override the global amount budget (atomic units or e.g. 5USDC)",
    )
    .option("--budget-task <amount>", "Override the per-task amount budget")
    .option("--budget-agent <amount>", "Override the per-agent amount budget")
    .option("--max-payments-global <n>", "Override the global payment-count limit")
    .option("--max-payments-task <n>", "Override the per-task payment-count limit")
    .option("--max-payments-agent <n>", "Override the per-agent payment-count limit")
    .option("--max-single <amount>", "Override the single-payment limit")
    .option(
      "--allow-host <host>",
      "Allow a host (repeatable; replaces the file's allow-list)",
      (value: string, previous: string[] = []) => [...previous, value],
    )
    .option(
      "--deny-host <host>",
      "Deny a host (repeatable; replaces the file's deny-list)",
      (value: string, previous: string[] = []) => [...previous, value],
    )
    .action(async (raw: unknown) => {
      const flags = startFlags.parse(raw);
      const overrides = startOverrides(flags, configFrom(flags));
      const config = loadConfig(
        {
          ...overrides.patch,
          ...(flags.db ? { db: flags.db } : {}),
          ...(flags.upstream ? { upstream: flags.upstream } : {}),
          ports: {
            ...(flags.proxyPort !== undefined ? { proxy: flags.proxyPort } : {}),
            ...(flags.dashboardPort !== undefined ? { dashboard: flags.dashboardPort } : {}),
          },
        },
        sourceOptions(flags),
      );
      const running = await startServices(config);
      output(
        `Taximeter ${version}\nProxy: http://127.0.0.1:${running.proxyPort}\nDashboard: http://127.0.0.1:${running.dashboardPort}\nPoint an HTTP-proxy-aware agent at http://127.0.0.1:${running.proxyPort}.\nHTTPS CONNECT is unmetered; use --upstream or withMeter for HTTPS payments.\n`,
      );
      const activeOverrides = [
        ...overrides.active,
        ...(flags.db !== undefined ? [{ key: "db", value: config.db }] : []),
        ...(flags.upstream !== undefined ? [{ key: "upstream", value: config.upstream }] : []),
        ...(flags.proxyPort !== undefined ? [{ key: "ports.proxy", value: flags.proxyPort }] : []),
        ...(flags.dashboardPort !== undefined
          ? [{ key: "ports.dashboard", value: flags.dashboardPort }]
          : []),
      ];
      for (const active of activeOverrides)
        output(`Override: ${active.key} = ${valueText(active.value)} (flags; not saved)\n`);
      const shutdown = () => {
        process.off("SIGINT", shutdown);
        process.off("SIGTERM", shutdown);
        void running.close().catch(() => {
          process.exitCode = 1;
        });
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    });
  options(
    program.command("report").description("Print exact totals, separately per network and asset"),
  )
    .option("--json", "Machine-readable integer-string totals")
    .option("--task <id>", "Filter by task")
    .option("--agent <id>", "Filter by agent")
    .option("--host <host>", "Filter by host")
    .action((raw: unknown) => {
      const flags = reportFlags.parse(raw);
      const db = configFrom(flags).db;
      const ledger = new Ledger(existsSync(db) ? db : ":memory:");
      try {
        const events = ledger
          .view()
          .filter(
            (event) =>
              (!flags.task || event.taskId === flags.task) &&
              (!flags.agent || event.agentId === flags.agent) &&
              (!flags.host || event.host === flags.host),
          );
        const total = totals(events);
        if (flags.json) output(`${JSON.stringify(total, null, 2)}\n`);
        else
          output(
            total.length
              ? `${total.map((item) => `${item.decimalsKnown ? formatAmount(item.amount, item.decimals) : item.amount} ${item.assetSymbol ?? `${item.asset} atomic units`} | ${item.network} | ${item.unknownAmount} atomic units uncertain`).join("\n")}\n`
              : "No payments recorded.\n",
          );
      } finally {
        ledger.close();
      }
    });
  options(program.command("export").description("Export the local ledger"))
    .option("--json <file>", "Write JSON to a new file (default: stdout)")
    .option("--csv <file>", "Write CSV with exact counted and authorized amounts")
    .option("--invoice <file>", "Write a printable HTML payment statement")
    .action((raw: unknown) => {
      const flags = exportFlags.parse(raw);
      const db = configFrom(flags).db;
      const ledger = new Ledger(existsSync(db) ? db : ":memory:");
      try {
        const events = ledger.view();
        const data = flags.csv ? toCsv(events) : flags.invoice ? toInvoice(events) : toJson(events);
        const file = flags.csv ?? flags.invoice ?? flags.json;
        if (file) {
          writeFileSync(resolve(file), data, { flag: "wx", mode: 0o600 });
          output(`Exported ${resolve(file)}\n`);
        } else output(data);
      } finally {
        ledger.close();
      }
    });
  options(
    program
      .command("reset")
      .description("Archive the current ledger after all writers have stopped"),
  )
    .option("--yes", "Confirm archiving the current ledger")
    .action((raw: unknown) => {
      const flags = resetFlags.parse(raw);
      if (!flags.yes)
        throw new Error(
          "Stop all Taximeter and SDK instances, then run taximeter reset --yes to archive the ledger.",
        );
      const { db } = configFrom(flags);
      assertStopped(db);
      if (!existsSync(db)) {
        output("No ledger to archive.\n");
        return;
      }
      const release = acquireLock(db);
      try {
        const ledger = new Ledger(db);
        ledger.close();
        const archive = `${db.endsWith(".db") ? db.slice(0, -3) : db}.archive-${Date.now()}.db`;
        if (existsSync(archive)) throw new Error("Archive path already exists; retry later.");
        renameSync(db, archive);
        for (const suffix of ["-wal", "-shm"])
          if (existsSync(`${db}${suffix}`)) renameSync(`${db}${suffix}`, `${archive}${suffix}`);
        output(`Archived ${archive}\n`);
      } finally {
        release();
      }
    });
  options(
    program.command("doctor").description("Check local config and SQLite without network requests"),
  )
    .option("--json", "Machine-readable configuration, sources, and local checks")
    .action((raw: unknown) => {
      const flags = common.extend({ json: z.boolean().optional() }).parse(raw);
      const details = loadConfigDetails(flags.db ? { db: flags.db } : {}, sourceOptions(flags));
      const config = details.config;
      const ledger = new Ledger(existsSync(config.db) ? config.db : ":memory:");
      try {
        const events = ledger.eventCount();
        output(
          flags.json
            ? `${JSON.stringify({ configuration: "valid", ...details, sqlite: { status: "ready", events }, ledger: config.db, listenerBinding: "127.0.0.1", httpsConnect: "unmetered", networkChecks: "none" }, null, 2)}\n`
            : `Configuration: valid\n${formatLayers(details)}\n\n${formatEffectiveConfig(config)}\n\nSQLite: ready (${events} events)\nLedger: ${config.db}\nListener binding: 127.0.0.1\nHTTPS CONNECT: unmetered\nNetwork checks: none\n`,
        );
      } finally {
        ledger.close();
      }
    });
  addConfigCommands(program, output, sources);
  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (error) {
    throw configError(error);
  }
}
