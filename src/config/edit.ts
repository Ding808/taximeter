import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { configPatchSchema, parseConfig, type TaximeterConfig } from "../config";
import { parseAmountInput } from "./amount-input";
import { type ConfigLoadOptions, expandPath, loadConfigDetails } from "./io";

function unwrapped(schema: z.ZodType): z.ZodType {
  if (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodDefault ||
    schema instanceof z.ZodPrefault
  ) {
    const inner = schema.unwrap();
    if (!(inner instanceof z.ZodType)) throw new Error("Unsupported configuration schema");
    return unwrapped(inner);
  }
  return schema;
}

function schemaPaths(schema: z.ZodType, prefix = ""): Map<string, z.ZodType> {
  const paths = new Map<string, z.ZodType>();
  const value = unwrapped(schema);
  if (prefix) paths.set(prefix, schema);
  if (value instanceof z.ZodObject) {
    for (const [key, child] of Object.entries(value.shape)) {
      if (!(child instanceof z.ZodType)) throw new Error("Unsupported configuration schema");
      for (const entry of schemaPaths(child, prefix ? `${prefix}.${key}` : key))
        paths.set(...entry);
    }
  }
  return paths;
}

function distance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      current[column] = Math.min(
        (current[column - 1] ?? 0) + 1,
        (previous[column] ?? 0) + 1,
        (previous[column - 1] ?? 0) + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length] ?? left.length;
}

export function schemaForKey(input: string): z.ZodType {
  const key = z.string().parse(input);
  const paths = schemaPaths(configPatchSchema);
  const schema = paths.get(key);
  if (schema) return schema;
  const nearest = [...paths.keys()].sort(
    (left, right) => distance(key, left) - distance(key, right) || left.localeCompare(right),
  )[0];
  throw new Error(`Unknown configuration key "${key}". Did you mean "${nearest}"?`);
}

export function configValue(config: unknown, key: string): unknown {
  schemaForKey(key);
  let value = config;
  for (const part of key.split(".")) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, part))
      return undefined;
    value = Reflect.get(value, part);
  }
  return value;
}

export function amountContext(config: TaximeterConfig, key: string) {
  if (key === "policy.maxSinglePayment") return { asset: config.policy.maxSingleAsset };
  const match = /^budgets\.(perTask|perAgent|global)\.amount$/.exec(key);
  if (!match) return undefined;
  const scope = z.enum(["perTask", "perAgent", "global"]).parse(match[1]);
  return config.budgets[scope] ?? { asset: "USDC" };
}

function parsedInput(key: string, input: string, config: TaximeterConfig): unknown {
  const schema = schemaForKey(key);
  const value = z.string().parse(input);
  if (value === "null") return null;
  const context = amountContext(config, key);
  if (context) return parseAmountInput(value, context.asset, context.network);
  const type = unwrapped(schema);
  if (type instanceof z.ZodArray) {
    if (value.trim().startsWith("[")) return JSON.parse(value);
    return value === "" ? [] : value.split(",").map((entry) => entry.trim());
  }
  if (type instanceof z.ZodObject) return JSON.parse(value);
  if (type instanceof z.ZodNumber)
    return z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/, "Use a plain integer without units")
      .transform(Number)
      .parse(value);
  return value;
}

export function parseConfigInput(key: string, input: string, config: TaximeterConfig): unknown {
  try {
    return parsedInput(key, input, config);
  } catch (error) {
    if (error instanceof z.ZodError)
      throw new z.ZodError(
        error.issues.map((issue) => ({ ...issue, path: [...key.split("."), ...issue.path] })),
      );
    if (error instanceof SyntaxError) throw new Error(`${key}: expected valid JSON`);
    throw error;
  }
}

export function configError(error: unknown): Error {
  if (error instanceof z.ZodError)
    return new Error(
      error.issues
        .map((issue) => `${issue.path.join(".") || "configuration"}: ${issue.message}`)
        .join("; "),
    );
  return error instanceof Error ? error : new Error("Invalid configuration");
}

function changePath(
  layer: Record<string, unknown>,
  key: string,
  value: unknown,
  unset: boolean,
): void {
  const parts = key.split(".");
  const final = parts.pop();
  if (!final) throw new Error("Expected a configuration key");
  let parent = layer;
  const ancestors: { value: Record<string, unknown>; key: string }[] = [];
  for (const part of parts) {
    const next = parent[part];
    if (next === null || typeof next !== "object" || Array.isArray(next)) {
      if (unset) return;
      parent[part] = {};
    }
    ancestors.push({ value: parent, key: part });
    parent = z.record(z.string(), z.unknown()).parse(parent[part]);
    const ancestor = ancestors.at(-1);
    if (ancestor) ancestor.value[part] = parent;
  }
  if (unset) {
    delete parent[final];
    for (const ancestor of ancestors.reverse()) {
      const child = ancestor.value[ancestor.key];
      if (child && typeof child === "object" && Object.keys(child).length === 0)
        delete ancestor.value[ancestor.key];
      else break;
    }
  } else parent[final] = value;
}

/** The destination is replaced only after both patch and effective configuration validation. */
function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  let created = false;
  try {
    const descriptor = openSync(temporary, "wx", 0o600);
    created = true;
    try {
      writeFileSync(descriptor, content, "utf8");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, path);
    created = false;
  } finally {
    if (created) unlinkSync(temporary);
  }
}

export function editConfig(input: {
  key: string;
  value?: string;
  unset?: boolean;
  file?: string;
  flags?: unknown;
  options?: ConfigLoadOptions;
}) {
  try {
    schemaForKey(input.key);
    const options = input.options ?? {};
    const before = loadConfigDetails(input.flags, options);
    const path = expandPath(input.file ?? before.defaultWritePath, options.home, options.cwd);
    if (path === ":memory:") throw new Error("Choose a configuration file path, not :memory:");
    const original = existsSync(path) ? readFileSync(path, "utf8") : undefined;
    const layer = configPatchSchema.parse(original === undefined ? {} : JSON.parse(original));
    const targetIndex = before.layers.map((entry) => entry.path).lastIndexOf(path);
    const participates = targetIndex >= 0;
    // Units belong to the file being edited, even when a higher layer selects another asset.
    const amountConfig =
      input.unset || !amountContext(before.config, input.key)
        ? before.config
        : participates
          ? loadConfigDetails(
              {},
              {
                ...options,
                env: {},
                layerOverrides: {
                  ...options.layerOverrides,
                  ...Object.fromEntries(
                    before.layers
                      .slice(0, targetIndex)
                      .filter((entry) => entry.path && entry.path !== path)
                      .map((entry) => [entry.path, {}]),
                  ),
                },
              },
            ).config
          : parseConfig(layer);
    const value = input.unset
      ? undefined
      : parseConfigInput(input.key, z.string().parse(input.value), amountConfig);
    changePath(layer, input.key, value, input.unset ?? false);
    const candidate = configPatchSchema.parse(layer);
    if (!participates) parseConfig(candidate);
    const after = loadConfigDetails(input.flags, {
      ...options,
      layerOverrides: { ...options.layerOverrides, [path]: candidate },
    });
    const unchanged = input.unset && original === undefined;
    if (!unchanged) atomicWrite(path, `${JSON.stringify(candidate, null, 2)}\n`);
    return {
      path,
      key: input.key,
      before: before.config,
      after: after.config,
      writtenValue: configValue(candidate, input.key),
      participates,
      changed: !unchanged,
    };
  } catch (error) {
    throw configError(error);
  }
}
