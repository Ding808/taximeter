import { execFileSync, spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const root = fileURLToPath(new URL("../", import.meta.url));
const versionSchema = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
const emptyArray = z.array(z.never()).length(0);
const freshSummarySchema = z.strictObject({
  version: versionSchema,
  generatedAt: z.iso.datetime(),
  totalEvents: z.literal(0),
  blockedEvents: z.literal(0),
  unknownEvents: z.literal(0),
  totals: emptyArray,
  events: emptyArray,
  diagnostics: emptyArray,
  groups: z.strictObject({ task: emptyArray, agent: emptyArray, host: emptyArray }),
  hours: z.array(z.strictObject({ ts: z.iso.datetime(), totals: emptyArray })).length(24),
  globalBudget: z.strictObject({
    amount: z.literal("100000000"),
    asset: z.literal("USDC"),
    window: z.literal("24h"),
  }),
  budgets: emptyArray,
  proxy: z.strictObject({ port: z.literal(8402) }),
});
const lockSchema = z.strictObject({ pid: z.number().int().positive() });
const assetPathSchema = z.string().regex(/^\/assets\/[A-Za-z0-9._-]+\.(js|css)$/);
const environmentSchema = z.record(z.string(), z.string().optional());
const doctorSchema = z.object({
  configuration: z.literal("valid"),
  config: z.object({
    db: z.string(),
    budgets: z.object({ global: z.object({ amount: z.string() }) }),
  }),
  sqlite: z.object({ status: z.literal("ready"), events: z.literal(0) }),
  networkChecks: z.literal("none"),
});

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function errorMessage(error) {
  const parsed = z.object({ message: z.string() }).safeParse(error);
  return parsed.success ? parsed.data.message : "Unknown error";
}

async function requireFreePort(port) {
  const server = createServer();
  await new Promise((resolvePort, reject) => {
    server.once("error", () => reject(new Error(`Default port ${port} is already in use.`)));
    server.listen(port, "127.0.0.1", () => server.close(resolvePort));
  });
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (z.object({ code: z.literal("ESRCH") }).safeParse(error).success) return false;
    throw error;
  }
}

function stopPid(pid, signal) {
  if (!processAlive(pid)) return;
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (!z.object({ code: z.literal("ESRCH") }).safeParse(error).success) throw error;
  }
}

async function waitStopped(pid, timeout) {
  const deadline = Date.now() + timeout;
  while (processAlive(pid) && Date.now() < deadline) await delay(100);
  return !processAlive(pid);
}

async function fetchLocal(path, mime) {
  const response = await fetch(`http://127.0.0.1:8403${path}`, {
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  requireCondition(response.status === 200, `${path} returned HTTP ${response.status}.`);
  const type = z.string().parse(response.headers.get("content-type"));
  requireCondition(type.split(";")[0] === mime, `${path} returned an incorrect MIME type: ${type}`);
  return response;
}

function installedCli(cache, version) {
  const installRoot = realpathSync(join(cache, "_npx"));
  const candidates = readdirSync(installRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(installRoot, entry.name, "node_modules", "taximeter"))
    .filter((directory) => existsSync(join(directory, "package.json")))
    .filter(
      (directory) =>
        z
          .object({ name: z.literal("taximeter"), version: z.literal(version) })
          .safeParse(JSON.parse(readFileSync(join(directory, "package.json"), "utf8"))).success,
    )
    .map((directory) => realpathSync(join(directory, "dist", "cli", "index.js")));
  requireCondition(
    candidates.length === 1,
    "Expected exactly one installed package in the fresh npx cache.",
  );
  const executable = z.string().parse(candidates[0]);
  requireCondition(
    executable.startsWith(`${installRoot}${sep}`) && statSync(executable).isFile(),
    "The installed CLI must stay within the isolated npx cache.",
  );
  return executable;
}

async function smokePackage() {
  const args = z
    .union([z.tuple([]), z.tuple([z.literal("--source")])])
    .parse(process.argv.slice(2));
  const source = args[0] === "--source";
  const manifest = z
    .object({ name: z.literal("taximeter"), version: versionSchema })
    .parse(JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")));
  const tarballFilename = `taximeter-${manifest.version}.tgz`;
  const inherited = environmentSchema.parse({ ...process.env });
  const npmCli = z
    .string()
    .min(1, "Run this check with npm run smoke:package")
    .refine(isAbsolute, "npm_execpath must be absolute")
    .refine((path) => basename(path) === "npm-cli.js", "Expected npm's npm-cli.js entry point")
    .parse(inherited.npm_execpath);
  const npxCli = join(dirname(realpathSync(npmCli)), "npx-cli.js");
  requireCondition(statSync(npxCli).isFile(), "The sibling npx-cli.js is missing.");
  const tarball = resolve(root, tarballFilename);
  if (!source) requireCondition(existsSync(tarball), "Run npm pack before the package smoke test.");
  else requireCondition(existsSync(resolve(root, "dist/cli/index.js")), "Run npm run build first.");
  await Promise.all([requireFreePort(8402), requireFreePort(8403)]);

  const temporaryParent = realpathSync(tmpdir());
  const owned = realpathSync(mkdtempSync(join(temporaryParent, "taximeter-package-smoke-")));
  const freshCwd = join(owned, "cwd");
  const home = join(owned, "home");
  const cache = join(owned, "npm-cache");
  for (const directory of [freshCwd, home, cache]) mkdirSync(directory);
  const cwd = source ? root : freshCwd;
  const userConfig = join(owned, "user.npmrc");
  const globalConfig = join(owned, "global.npmrc");
  writeFileSync(userConfig, "");
  writeFileSync(globalConfig, "");
  if (!source) copyFileSync(tarball, join(cwd, tarballFilename));
  requireCondition(
    !existsSync(join(cwd, "taximeter.config.json")),
    "The working directory has a config file.",
  );
  requireCondition(
    !existsSync(join(home, ".taximeter/config.json")),
    "The fresh home has a config file.",
  );

  const environment = { ...inherited };
  for (const key of Object.keys(environment)) {
    if (
      /^TAXIMETER_/i.test(key) ||
      /^npm_config_(cache|prefix|local_prefix|userconfig|globalconfig)$/i.test(key)
    )
      delete environment[key];
  }
  const pathKey = Object.keys(environment).find((key) => key.toLowerCase() === "path") ?? "PATH";
  environment[pathKey] = `${dirname(process.execPath)}${delimiter}${environment[pathKey] ?? ""}`;
  Object.assign(environment, {
    HOME: home,
    USERPROFILE: home,
    npm_config_cache: cache,
    npm_config_userconfig: userConfig,
    npm_config_globalconfig: globalConfig,
    npm_config_yes: "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
  });

  console.log(`Smoke runtime: ${process.version}`);
  console.log(`Smoke workspace: ${owned}`);
  console.log(
    "PASS: isolated home and npm cache; no Taximeter config file or environment overrides.",
  );
  console.log(source ? "$ node dist/cli/index.js start" : `$ npx ./${tarballFilename} start`);
  const child = spawn(
    process.execPath,
    source
      ? [resolve(root, "dist/cli/index.js"), "start"]
      : [npxCli, `./${tarballFilename}`, "start"],
    { cwd, env: environment, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  let childError;
  let exited = false;
  let boot = "";
  let interrupted = false;
  let cliPid;
  let passed = false;
  const interruptedSignal = () => {
    interrupted = true;
  };
  process.on("SIGINT", interruptedSignal);
  process.on("SIGTERM", interruptedSignal);
  child.on("error", (error) => {
    childError = error;
  });
  child.on("exit", () => {
    exited = true;
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (input) => {
    const chunk = z.string().parse(input);
    process.stdout.write(chunk);
    boot = `${boot}${chunk}`.slice(-32_768);
  });
  child.stderr.on("data", (input) => process.stderr.write(z.string().parse(input)));
  const lockPath = join(home, ".taximeter/ledger.db.lock");

  try {
    const deadline = Date.now() + 180_000;
    let progressAt = Date.now() + 30_000;
    while (
      !/^Proxy: http:\/\/127\.0\.0\.1:8402\r?$/m.test(boot) ||
      !/^Dashboard: http:\/\/127\.0\.0\.1:8403\r?$/m.test(boot)
    ) {
      if (childError) throw childError;
      requireCondition(!exited, `The startup process exited before boot (code ${child.exitCode}).`);
      requireCondition(!interrupted, "Smoke test interrupted.");
      requireCondition(Date.now() < deadline, "Startup timed out after 180 seconds.");
      if (Date.now() >= progressAt) {
        console.log("Installing the local package and waiting for its default listeners...");
        progressAt = Date.now() + 30_000;
      }
      await delay(100);
    }
    cliPid = lockSchema.parse(JSON.parse(readFileSync(lockPath, "utf8"))).pid;
    requireCondition(cliPid !== process.pid, "The child lock unexpectedly names the smoke runner.");
    requireCondition(processAlive(cliPid), "The packaged CLI exited after boot.");
    requireCondition(
      existsSync(join(home, ".taximeter/ledger.db")),
      "The default ledger was not created in the isolated home.",
    );
    console.log(
      "PASS: default proxy 8402 and dashboard 8403; default ledger created in the fresh home.",
    );

    const summary = await fetchLocal("/api/summary", "application/json");
    freshSummarySchema.extend({ version: z.literal(manifest.version) }).parse(await summary.json());
    console.log(
      "PASS: validated empty dashboard summary and default budget without configuration.",
    );
    const document = await fetchLocal("/", "text/html");
    const html = z
      .string()
      .min(1)
      .parse(await document.text());
    requireCondition(
      /id=["']root["']/.test(html),
      "The dashboard did not serve its built React entry point.",
    );
    const assets = [
      ...new Set(
        [...html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)=["']([^"']+)["']/gi)].map(
          (match) => assetPathSchema.parse(match[1]),
        ),
      ),
    ];
    requireCondition(
      assets.some((path) => path.endsWith(".js")),
      "The page has no bundled JavaScript asset.",
    );
    requireCondition(
      assets.some((path) => path.endsWith(".css")),
      "The page has no bundled CSS asset.",
    );
    for (const path of assets) {
      const response = await fetchLocal(
        path,
        path.endsWith(".js") ? "text/javascript" : "text/css",
      );
      const body = await response.arrayBuffer();
      requireCondition(body.byteLength > 0, `The built asset is empty: ${path}`);
    }
    console.log(
      `PASS: prebuilt dashboard HTML and ${assets.length} local JS/CSS assets served with correct MIME types.`,
    );

    // Reuse the exact installed executable. These commands never invoke npm or the registry.
    const executable = source
      ? resolve(root, "dist/cli/index.js")
      : installedCli(cache, manifest.version);
    const runInstalled = (args) =>
      execFileSync(process.execPath, [executable, ...args], {
        cwd,
        env: environment,
        encoding: "utf8",
        timeout: 15_000,
        maxBuffer: 2_000_000,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    const originalDoctor = doctorSchema.parse(JSON.parse(runInstalled(["doctor", "--json"])));
    requireCondition(
      originalDoctor.config.db === join(home, ".taximeter", "ledger.db") &&
        originalDoctor.config.budgets.global.amount === "100000000",
      "The installed doctor's JSON must describe the isolated home and the default budget.",
    );
    console.log(
      "PASS: installed doctor --json reports the effective default configuration and local ledger.",
    );

    const written = runInstalled(["config", "set", "budgets.global.amount", "200USDC"]);
    const configPath = join(home, ".taximeter", "config.json");
    z.object({ budgets: z.object({ global: z.object({ amount: z.literal("200000000") }) }) }).parse(
      JSON.parse(readFileSync(configPath, "utf8")),
    );
    requireCondition(
      written.includes(`Written to ${configPath}`) &&
        written.includes("Restart taximeter for this to take effect."),
      "The installed config command must identify its isolated write target and restart requirement.",
    );
    requireCondition(
      runInstalled(["config", "get", "budgets.global.amount"]).trim() === "200000000",
      "The installed config get command did not return the exact atomic amount.",
    );
    const updatedDoctor = doctorSchema.parse(JSON.parse(runInstalled(["doctor", "--json"])));
    requireCondition(
      updatedDoctor.config.db === originalDoctor.config.db &&
        updatedDoctor.config.budgets.global.amount === "200000000",
      "The installed doctor's JSON does not agree with the stored and retrieved budget.",
    );
    requireCondition(
      !existsSync(join(cwd, "taximeter.config.json")),
      "Config set changed the smoke working directory.",
    );
    console.log("PASS: installed config set/get stores 200USDC as 200000000; doctor JSON agrees.");

    const unchanged = await fetchLocal("/api/summary", "application/json");
    freshSummarySchema
      .extend({ version: z.literal(manifest.version) })
      .parse(await unchanged.json());
    console.log("PASS: editing the file does not change the already-running meter before restart.");
    console.log(
      "PASS: smoke HTTP requests stayed on loopback; browser network behavior is verified separately.",
    );
    passed = true;
  } finally {
    process.off("SIGINT", interruptedSignal);
    process.off("SIGTERM", interruptedSignal);
    // The CLI can be a grandchild of npx on Windows; its isolated lock identifies it.
    if (cliPid === undefined && existsSync(lockPath))
      cliPid = lockSchema.parse(JSON.parse(readFileSync(lockPath, "utf8"))).pid;
    if (cliPid !== undefined) {
      requireCondition(
        cliPid !== process.pid,
        "Refusing to stop the smoke runner via a child lock.",
      );
      stopPid(cliPid, "SIGTERM");
      if (!(await waitStopped(cliPid, 5_000))) {
        stopPid(cliPid, "SIGKILL");
        requireCondition(await waitStopped(cliPid, 5_000), "The owned CLI process did not stop.");
      }
    }
    if (child.pid !== undefined && !exited) {
      const parentPid = z.number().int().positive().parse(child.pid);
      if (!(await waitStopped(parentPid, 3_000))) {
        stopPid(parentPid, "SIGTERM");
        if (!(await waitStopped(parentPid, 3_000))) stopPid(parentPid, "SIGKILL");
        requireCondition(await waitStopped(parentPid, 3_000), "The owned launcher did not stop.");
      }
    }
    console.log("PASS: owned CLI and launcher processes stopped.");
    if (passed) {
      const target = realpathSync(owned);
      requireCondition(
        isAbsolute(target) &&
          target === owned &&
          dirname(target) === temporaryParent &&
          basename(target).startsWith("taximeter-package-smoke-") &&
          target.startsWith(`${temporaryParent}${sep}`),
        "Refusing to remove a directory outside the owned temporary workspace.",
      );
      rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      console.log("PASS: verified temporary workspace removed.");
    } else console.error(`Smoke evidence retained at: ${owned}`);
  }
}

try {
  await smokePackage();
} catch (error) {
  console.error(`Package smoke failed: ${errorMessage(error)}`);
  process.exitCode = 1;
}
