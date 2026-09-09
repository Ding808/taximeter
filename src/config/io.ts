import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { configPatchSchema, parseConfig, type TaximeterConfig } from "../config";

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
  } catch (error) {
    const detail =
      error instanceof z.ZodError
        ? error.issues
            .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
            .join("; ")
        : "expected valid JSON";
    throw new Error(`Invalid Taximeter configuration: ${path}: ${detail}`);
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

export type ConfigLoadOptions = {
  cwd?: string;
  home?: string;
  env?: unknown;
  configFile?: string;
  /** Candidate file contents for validation; this never changes the filesystem. */
  layerOverrides?: Record<string, unknown>;
};

export type ConfigLayer = {
  name: "flags" | "environment" | "explicit" | "cwd" | "home" | "defaults";
  label: string;
  path?: string;
  exists: boolean;
  supplied: boolean;
  contributed: boolean;
  keys: string[];
  contributedKeys: string[];
  overriddenKeys: string[];
  environmentVariables?: string[];
};

export type ConfigDetails = {
  config: TaximeterConfig;
  /** Ordered from highest priority to lowest priority. */
  layers: ConfigLayer[];
  defaultWritePath: string;
};

function leafKeys(value: unknown, prefix = ""): string[] {
  if (value === undefined) return [];
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [prefix];
  return Object.entries(value).flatMap(([key, child]) =>
    leafKeys(child, prefix ? `${prefix}.${key}` : key),
  );
}

export function loadConfigDetails(
  flags: unknown = {},
  options: ConfigLoadOptions = {},
): ConfigDetails {
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
  const paths = {
    home: expandPath(resolve(home, ".taximeter", "config.json"), home, cwd),
    cwd: expandPath(resolve(cwd, "taximeter.config.json"), home, cwd),
    explicit: options.configFile ? expandPath(options.configFile, home, cwd) : undefined,
  };
  const overridden = (path: string) => Object.hasOwn(options.layerOverrides ?? {}, path);
  const fileValue = (path: string | undefined) =>
    !path
      ? {}
      : overridden(path)
        ? configPatchSchema.parse(options.layerOverrides?.[path])
        : readConfig(path);
  if (paths.explicit && !existsSync(paths.explicit) && !overridden(paths.explicit))
    throw new Error(`Configuration file not found: ${options.configFile}`);
  const values = {
    defaults: parseConfig(),
    home: fileValue(paths.home),
    cwd: fileValue(paths.cwd),
    explicit: fileValue(paths.explicit),
    environment,
    flags: configPatchSchema.parse(flags),
  };
  const config = parseConfig(
    values.home,
    values.cwd,
    values.explicit,
    values.environment,
    values.flags,
  );
  const names = ["defaults", "home", "cwd", "explicit", "environment", "flags"] as const;
  const labels: Record<ConfigLayer["name"], string> = {
    flags: "flags",
    environment: "environment",
    explicit: "--config",
    cwd: "cwd",
    home: "home",
    defaults: "defaults",
  };
  const owners = new Map<string, ConfigLayer["name"]>();
  for (const name of names) {
    for (const key of leafKeys(values[name])) {
      for (const owned of owners.keys()) {
        if (owned === key || owned.startsWith(`${key}.`) || key.startsWith(`${owned}.`))
          owners.delete(owned);
      }
      owners.set(key, name);
    }
  }
  const layers = names
    .map((name): ConfigLayer => {
      const path =
        name === "home" || name === "cwd" || name === "explicit" ? paths[name] : undefined;
      const keys = leafKeys(values[name]);
      const contributedKeys = keys.filter((key) => owners.get(key) === name);
      return {
        name,
        label: labels[name] ?? name,
        ...(path ? { path } : {}),
        exists: path ? existsSync(path) : name === "defaults" || keys.length > 0,
        supplied: path
          ? existsSync(path) || overridden(path)
          : name === "defaults" || keys.length > 0,
        contributed: contributedKeys.length > 0,
        keys,
        contributedKeys,
        overriddenKeys: keys.filter((key) => !contributedKeys.includes(key)),
        ...(name === "environment"
          ? {
              environmentVariables: Object.keys(env).filter(
                (key) => env[key as keyof typeof env] !== undefined,
              ),
            }
          : {}),
      };
    })
    .reverse();
  return {
    config: { ...config, db: expandPath(config.db, home, cwd) },
    layers,
    defaultWritePath: existsSync(paths.cwd) ? paths.cwd : paths.home,
  };
}

export function loadConfig(flags: unknown = {}, options: ConfigLoadOptions = {}) {
  return loadConfigDetails(flags, options).config;
}
