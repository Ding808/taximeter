import type { Command } from "commander";
import { z } from "zod";
import { formatAmount } from "../config/amount-input";
import { formatEffectiveConfig, formatLayers } from "../config/display";
import { amountContext, configValue, editConfig, schemaForKey } from "../config/edit";
import { type ConfigLoadOptions, loadConfigDetails } from "../config/io";

const common = z.strictObject({ db: z.string().optional(), config: z.string().optional() });
const showFlags = common.extend({ json: z.boolean().optional() });
const editFlags = common.extend({ file: z.string().min(1).optional() });

function options(command: Command): Command {
  return command
    .option("--db <path>", "SQLite ledger path")
    .option("--config <path>", "Explicit config file");
}

export function valueText(value: unknown): string {
  return value === undefined
    ? "(not set)"
    : typeof value === "string"
      ? value
      : JSON.stringify(value);
}

export function addConfigCommands(
  program: Command,
  output: (text: string) => void,
  sources: ConfigLoadOptions,
): void {
  const group = options(
    program.command("config").description("Inspect or edit local configuration"),
  );
  const details = (flags: z.infer<typeof common>) =>
    loadConfigDetails(flags.db ? { db: flags.db } : {}, {
      ...sources,
      configFile: flags.config ?? sources.configFile,
    });
  options(
    group.command("path").description("Show configuration layers and the default write target"),
  ).action((_raw: unknown, command: Command) => {
    const resolved = details(common.parse(command.optsWithGlobals()));
    output(
      `${formatLayers(resolved)}\nDefault write target: ${resolved.defaultWritePath}\nUse --file to write a different layer; --config selects a read layer.\n`,
    );
  });
  options(group.command("show").description("Show the merged effective configuration"))
    .option("--json", "Print the effective configuration as JSON")
    .action((_raw: unknown, command: Command) => {
      const flags = showFlags.parse(command.optsWithGlobals());
      const resolved = details(flags);
      output(
        flags.json
          ? `${JSON.stringify(resolved.config, null, 2)}\n`
          : `${formatLayers(resolved)}\n\n${formatEffectiveConfig(resolved.config)}\n\nLedger: ${resolved.config.db}\nProxy port: ${resolved.config.ports.proxy}\nDashboard port: ${resolved.config.ports.dashboard}\nUpstream: ${resolved.config.upstream ?? "(not set)"}\n`,
      );
    });
  options(group.command("get <key>").description("Read one effective value by dot path")).action(
    (key: string, _raw: unknown, command: Command) => {
      schemaForKey(key);
      output(
        `${valueText(configValue(details(common.parse(command.optsWithGlobals())).config, key))}\n`,
      );
    },
  );
  const edit = (key: string, value: string | undefined, command: Command, unset: boolean) => {
    const flags = editFlags.parse(command.optsWithGlobals());
    const result = editConfig({
      key,
      value,
      unset,
      file: flags.file,
      flags: flags.db ? { db: flags.db } : {},
      options: { ...sources, configFile: flags.config ?? sources.configFile },
    });
    const before = configValue(result.before, key);
    const after = configValue(result.after, key);
    const next = unset ? after : result.writtenValue;
    const beforeContext = amountContext(result.before, key);
    const afterContext = unset ? amountContext(result.after, key) : result.writtenAmountContext;
    const human =
      typeof before === "string" &&
      typeof next === "string" &&
      beforeContext &&
      afterContext &&
      beforeContext.asset === afterContext.asset &&
      beforeContext.network === afterContext.network
        ? `  (${formatAmount(before, beforeContext.asset, beforeContext.network)} → ${formatAmount(next, afterContext.asset, afterContext.network)})`
        : "";
    output(
      `${key}: ${valueText(before)} → ${unset ? `(unset in file; effective: ${valueText(after)})` : valueText(next)}${human}\n`,
    );
    output(result.changed ? `Written to ${result.path}\n` : `No file to change: ${result.path}\n`);
    if (!result.participates)
      output(
        "This file is not an active layer. Select it with --config when starting taximeter.\n",
      );
    else if (!unset && JSON.stringify(after) !== JSON.stringify(next))
      output(
        `The written value is overridden. Effective ${key}: ${valueText(after)}. Run taximeter config path to inspect the layers.\n`,
      );
    output("Restart taximeter for this to take effect.\n");
  };
  options(
    group
      .command("set <key> <value>")
      .description("Validate and atomically write one configuration value"),
  )
    .option("--file <path>", "Layer to write (default: existing cwd config, otherwise home config)")
    .action((key: string, value: string, _raw: unknown, command: Command) =>
      edit(key, value, command, false),
    );
  options(group.command("unset <key>").description("Remove a value from a configuration layer"))
    .option("--file <path>", "Layer to write (default: existing cwd config, otherwise home config)")
    .action((key: string, _raw: unknown, command: Command) => edit(key, undefined, command, true));
}
