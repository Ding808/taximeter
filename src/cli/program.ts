import { existsSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import { z } from "zod";
import { loadConfig, portInputSchema } from "../config/io";
import { toCsv, toInvoice, toJson } from "../export";
import { formatAmount, totals } from "../ledger/derive";
import { Ledger } from "../ledger/store";
import { httpUrlSchema, labelSchema } from "../model";
import { acquireLock, assertStopped, startServices } from "../server/lifecycle";

const common = z.strictObject({ db: z.string().optional(), config: z.string().optional() });
const port = portInputSchema.optional();
const startFlags = common.extend({
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
function configFrom(flags: z.infer<typeof common>) {
  return loadConfig(flags.db ? { db: flags.db } : {}, { configFile: flags.config });
}

export async function runCli(
  input: string[],
  output: (text: string) => void = (text) => process.stdout.write(text),
): Promise<void> {
  const argv = z.array(z.string()).parse(input);
  const program = new Command()
    .name("taximeter")
    .description("A taximeter for your AI agents.")
    .version("0.1.0")
    .exitOverride();
  program.configureOutput({ writeOut: output, writeErr: (text) => process.stderr.write(text) });
  options(program.command("start").description("Start the local proxy and dashboard"))
    .option("--proxy-port <port>", "Proxy port (0 selects an available port)")
    .option("--dashboard-port <port>", "Dashboard port")
    .option("--upstream <url>", "Forward origin-form requests to this HTTP(S) upstream")
    .action(async (raw: unknown) => {
      const flags = startFlags.parse(raw);
      const config = loadConfig(
        {
          ...(flags.db ? { db: flags.db } : {}),
          ...(flags.upstream ? { upstream: flags.upstream } : {}),
          ports: {
            ...(flags.proxyPort !== undefined ? { proxy: flags.proxyPort } : {}),
            ...(flags.dashboardPort !== undefined ? { dashboard: flags.dashboardPort } : {}),
          },
        },
        { configFile: flags.config },
      );
      const running = await startServices(config);
      output(
        `Taximeter 0.1.0\nProxy: http://127.0.0.1:${running.proxyPort}\nDashboard: http://127.0.0.1:${running.dashboardPort}\nPoint an HTTP-proxy-aware agent at http://127.0.0.1:${running.proxyPort}.\nHTTPS CONNECT is unmetered; use --upstream or withMeter for HTTPS payments.\n`,
      );
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
  ).action((raw: unknown) => {
    const config = configFrom(common.parse(raw));
    const ledger = new Ledger(existsSync(config.db) ? config.db : ":memory:");
    try {
      output(
        `Configuration: valid\nSQLite: ready (${ledger.events().length} events)\nLedger: ${config.db}\nListener binding: 127.0.0.1\nHTTPS CONNECT: unmetered\nNetwork checks: none\n`,
      );
    } finally {
      ledger.close();
    }
  });
  await program.parseAsync(argv, { from: "user" });
}
