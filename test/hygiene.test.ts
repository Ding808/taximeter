import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { z } from "zod";

const root = fileURLToPath(new URL("../", import.meta.url));
const generated = [
  "SPEC.md",
  "node_modules/example/index.js",
  "dist/index.js",
  "dist/ui/index.html",
  "build.tsbuildinfo",
  ".vite/cache.json",
  "coverage/coverage-final.json",
  ".nyc_output/results.json",
  "test-results/results.json",
  "tmp/smoke-output.txt",
  "taximeter-0.1.0.tgz",
  "taximeter-0.1.1.tgz",
  "taximeter-9.8.7.tgz",
  "ledger.db",
  "ledger.db-wal",
  "ledger.db-shm",
  "nested/local.db",
  "nested/local.db-wal",
  "nested/local.db-shm",
  ".taximeter/ledger.db",
  "taximeter.config.json",
  ".env",
  ".env.local",
  ".env.production.local",
  ".envrc",
  "development-session.log",
  "nested/runtime.log",
  ".DS_Store",
  "Thumbs.db",
  "Desktop.ini",
  ".idea/workspace.xml",
  ".vscode/local.private.json",
];
const required = [
  "SPEC-NOTES.md",
  "DECISIONS.md",
  "VERIFICATION.md",
  "README.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "LICENSE",
  "CODE_OF_CONDUCT.md",
  "taximeter.config.example.json",
  ".gitattributes",
  ".gitignore",
  "migrations/001.sql",
  "migrations/002.sql",
  "migrations/003.sql",
  "test/__snapshots__/export.test.ts.snap",
  ".changeset/README.md",
  ".changeset/config.json",
  ".github/workflows/ci.yml",
  ".github/workflows/release.yml",
];

function ignored(paths: string[]): string[] {
  const result = spawnSync("git", ["check-ignore", "--no-index", "--stdin"], {
    cwd: root,
    encoding: "utf8",
    input: `${paths.join("\n")}\n`,
    timeout: 10_000,
  });
  if (result.error) throw result.error;
  expect([0, 1]).toContain(result.status);
  expect(result.stderr).toBe("");
  return z.string().parse(result.stdout).split(/\r?\n/).filter(Boolean);
}

function tracked(): string[] {
  return z
    .string()
    .parse(
      execFileSync("git", ["ls-files", "-z"], {
        cwd: root,
        encoding: "utf8",
        timeout: 10_000,
      }),
    )
    .split("\0")
    .filter(Boolean);
}

describe("repository hygiene contract", () => {
  test("every normal generated artifact and local secret pattern is ignored", () => {
    expect(ignored(generated).sort()).toEqual([...generated].sort());
  });

  test("required deliverables and contributor examples are not ignored", () => {
    expect(
      ignored([
        ...required,
        ".env.example",
        ".vscode/extensions.json",
        ".vscode/settings.json",
        "migrations/002_example.sql",
        "test/__snapshots__/future.test.ts.snap",
        ".changeset/future-release.md",
        ".github/ISSUE_TEMPLATE/bug_report.md",
      ]),
    ).toEqual([]);
  });

  test("protocol notes, verification evidence, migrations, snapshots, and release configuration are tracked", () => {
    const paths = tracked();
    for (const path of required) {
      expect(paths, `${path} must remain tracked`).toContain(path);
      expect(existsSync(resolve(root, path)), `${path} must exist`).toBe(true);
    }
  });

  test("generated output and local state are not already tracked", () => {
    const accidental = tracked().filter((path) => {
      if (path === ".env.example") return false;
      if ([".vscode/extensions.json", ".vscode/settings.json"].includes(path)) return false;
      return (
        /(^|\/)(node_modules|dist|coverage|\.nyc_output|test-results|tmp|\.vite|\.taximeter|\.idea|\.vscode)\//.test(
          path,
        ) ||
        /\.(tgz|db|db-wal|db-shm|tsbuildinfo|log)$/.test(path) ||
        /(^|\/)(\.env[^/]*|\.DS_Store|Thumbs\.db|Desktop\.ini|taximeter\.config\.json)$/.test(path)
      );
    });
    expect(accidental).toEqual([]);
  });

  test("Git enforces LF text and shell files without a competing npm ignore file", () => {
    expect(existsSync(resolve(root, ".npmignore"))).toBe(false);
    const attributes = readFileSync(resolve(root, ".gitattributes"), "utf8");
    expect(attributes).toMatch(/^\* text=auto eol=lf$/m);
    expect(attributes).toMatch(/^\*\.sh text eol=lf$/m);
    const output = execFileSync(
      "git",
      ["check-attr", "text", "eol", "--", "src/index.ts", "scripts/example.sh"],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    expect(output).toContain("src/index.ts: text: auto");
    expect(output).toContain("src/index.ts: eol: lf");
    expect(output).toContain("scripts/example.sh: text: set");
    expect(output).toContain("scripts/example.sh: eol: lf");
  });
});
