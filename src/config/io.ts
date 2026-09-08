import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { configPatchSchema, parseConfig } from "../config";

export function expandPath(input: string, home = homedir(), cwd = process.cwd()): string {
  let path = z.string().min(1).parse(input);
  if (path === ":memory:") return path;
  if (path === "~") path = home;
  else if (path.startsWith("~/") || path.startsWith("~\\")) path = join(home, path.slice(2));
  const absolute = isAbsolute(path) ? path : resolve(cwd, path);
  return existsSync(absolute)
    ? realpathSync(absolute)
    : existsSync(dirname(absolute))
      ? join(realpathSync(dirname(absolute)), basename(absolute))
      : absolute;
}

function readConfig(path: string): unknown {
  if (!existsSync(path)) return {};
  try {
    return configPatchSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    throw new Error(`Invalid Taximeter configuration: ${path}`);
  }
}

export const portInputSchema = z
  .string()
  .regex(/^[0-9]{1,5}$/)
  .pipe(z.coerce.number<string>().int().min(0).max(65535));
const environmentSchema = z.object({
  TAXIMETER_DB: z.string().min(1).optional(),
  TAXIMETER_PORT: portInputSchema.optional(),
  TAXIMETER_DASHBOARD_PORT: portInputSchema.optional(),
});

export function loadConfig(
  flags: unknown = {},
  options: { cwd?: string; home?: string; env?: unknown; configFile?: string } = {},
) {
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? homedir();
  const env = environmentSchema.parse(options.env ?? process.env);
  const environment = {
    ...(env.TAXIMETER_DB ? { db: env.TAXIMETER_DB } : {}),
    ports: {
      ...(env.TAXIMETER_PORT !== undefined ? { proxy: env.TAXIMETER_PORT } : {}),
      ...(env.TAXIMETER_DASHBOARD_PORT !== undefined
        ? { dashboard: env.TAXIMETER_DASHBOARD_PORT }
        : {}),
    },
  };
  if (options.configFile && !existsSync(resolve(cwd, options.configFile)))
    throw new Error(`Configuration file not found: ${options.configFile}`);
  const config = parseConfig(
    readConfig(join(home, ".taximeter", "config.json")),
    readConfig(join(cwd, "taximeter.config.json")),
    ...(options.configFile ? [readConfig(resolve(cwd, options.configFile))] : []),
    environment,
    flags,
  );
  return { ...config, db: expandPath(config.db, home, cwd) };
}
