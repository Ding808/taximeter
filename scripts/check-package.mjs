import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const root = fileURLToPath(new URL("../", import.meta.url));
const packageSchema = z.object({
  name: z.literal("taximeter"),
  version: z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/),
  type: z.literal("module"),
  bin: z.object({
    taximeter: z.literal("dist/cli/index.js"),
    txm: z.literal("dist/cli/index.js"),
  }),
  files: z.array(z.string().min(1)).min(1),
});
const packageFileSchema = z.object({
  path: z
    .string()
    .min(1)
    .refine(
      (path) =>
        !path.startsWith("/") &&
        !path.includes("\\") &&
        !path.split("/").some((part) => part === ".." || part === "."),
      "Package entry must be a relative path without traversal",
    ),
  size: z.number().int().nonnegative(),
});
const metadataSchema = (version) =>
  z
    .array(
      z.object({
        name: z.literal("taximeter"),
        version: z.literal(version),
        filename: z.literal(`taximeter-${version}.tgz`),
        size: z.number().int().positive().lt(2_000_000),
        unpackedSize: z.number().int().positive(),
        entryCount: z.number().int().positive(),
        files: z.array(packageFileSchema).min(1),
      }),
    )
    .length(1);

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function checkMarkdownLinks(paths) {
  let checked = 0;
  for (const path of paths.filter((entry) => entry.endsWith(".md"))) {
    const markdown = z
      .string()
      .parse(readFileSync(resolve(root, path), "utf8"))
      .replace(/^```[\s\S]*?^```[^\n]*$/gm, "");
    for (const link of markdown.matchAll(
      /\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\)/g,
    )) {
      const destination = z.string().parse(link[1] ?? link[2]);
      if (/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(destination)) continue;
      const relative = decodeURIComponent(destination.split(/[?#]/)[0] ?? "");
      if (!relative || relative.endsWith("/")) continue;
      const target = posix.normalize(posix.join(posix.dirname(path), relative));
      if (paths.some((entry) => entry.startsWith(`${target}/`))) continue;
      requireCondition(
        paths.includes(target),
        `Broken packaged Markdown link: ${path} -> ${destination}`,
      );
      checked += 1;
    }
  }
  return checked;
}

function checkPackage() {
  const npmCli = z
    .string()
    .min(1, "Run this check with npm run check:package")
    .parse(process.env.npm_execpath);
  const manifest = packageSchema.parse(
    JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")),
  );
  const allowedWhitelist = new Set([
    "dist",
    "README.md",
    "LICENSE",
    "SECURITY.md",
    "CHANGELOG.md",
    "taximeter.config.example.json",
    "docs/SDK.md",
    "docs/demo.gif",
  ]);
  requireCondition(
    manifest.files.includes("dist"),
    "The npm files whitelist must include the prebuilt dist directory",
  );
  requireCondition(
    manifest.files.every((path) => allowedWhitelist.has(path)),
    "The npm files whitelist contains source or an unexpected directory",
  );

  const output = execFileSync(process.execPath, [npmCli, "pack", "--json"], {
    cwd: root,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 5_000_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const metadata = metadataSchema(manifest.version).parse(JSON.parse(output))[0];
  if (!metadata) throw new Error("npm pack returned no package metadata");
  const paths = metadata.files.map((file) => file.path);
  requireCondition(new Set(paths).size === paths.length, "The package contains duplicate paths");
  requireCondition(
    metadata.entryCount === paths.length,
    "Package entry count does not match npm metadata",
  );
  for (const path of paths) {
    const included =
      path === "package.json" ||
      manifest.files.some((entry) => path === entry || path.startsWith(`${entry}/`));
    requireCondition(included, `Package entry is outside the files whitelist: ${path}`);
    requireCondition(
      !/(^|\/)(src|test|tests|node_modules|coverage|\.git|\.taximeter)\//.test(path),
      `Development or local files leaked into the package: ${path}`,
    );
    requireCondition(
      !/\.(db|db-wal|db-shm|log|tsbuildinfo)$/.test(path),
      `Local state leaked into the package: ${path}`,
    );
    requireCondition(
      !/(^|\/)\.env[^/]*$/.test(path),
      `Environment file leaked into the package: ${path}`,
    );
    requireCondition(
      !/\.(tsx|ts)$/.test(path) || (path.startsWith("dist/") && path.endsWith(".d.ts")),
      `Uncompiled source leaked into the package: ${path}`,
    );
    requireCondition(
      !(path.startsWith("dist/ui/") && path.endsWith(".map")),
      `A UI source map leaked into the package: ${path}`,
    );
  }
  for (const path of [
    "package.json",
    "README.md",
    "LICENSE",
    "SECURITY.md",
    "CHANGELOG.md",
    "taximeter.config.example.json",
    "docs/SDK.md",
    "docs/demo.gif",
    "dist/index.js",
    "dist/index.d.ts",
    "dist/cli/index.js",
    "dist/ui/index.html",
  ]) {
    requireCondition(paths.includes(path), `Required published file is missing: ${path}`);
  }
  requireCondition(
    paths.some((path) => /^dist\/ui\/.+\.js$/.test(path)),
    "The package is missing built UI JavaScript",
  );
  requireCondition(
    paths.some((path) => /^dist\/ui\/.+\.css$/.test(path)),
    "The package is missing built UI CSS",
  );
  const tarball = resolve(root, metadata.filename);
  const bytes = z.number().int().positive().lt(2_000_000).parse(statSync(tarball).size);
  requireCondition(bytes === metadata.size, "Actual tarball size differs from npm metadata");
  const links = checkMarkdownLinks(paths);
  console.log(`Package verified: ${metadata.filename}`);
  console.log(
    `${bytes} bytes compressed; ${metadata.unpackedSize} bytes unpacked; ${paths.length} files.`,
  );
  console.log("Both CLI aliases, ESM entry point, declarations, and prebuilt UI are present.");
  console.log(`${links} relative Markdown file links resolve inside the package.`);
  console.log(
    "Files whitelist honored; no UI source maps, source tree, tests, dependencies, or local state.",
  );
}

try {
  checkPackage();
} catch (error) {
  console.error(
    `Package check failed: ${error instanceof Error ? error.message : "Unknown error"}`,
  );
  process.exitCode = 1;
}
