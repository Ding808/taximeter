import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { expect, test } from "vitest";

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sources(path) : /\.[cm]?[jt]sx?$/.test(path) ? [path] : [];
  });
}

test("source never converts integer-string money through floating-point parsers", () => {
  const failures: string[] = [];
  for (const path of sources("src")) {
    const file = ts.createSourceFile(
      path,
      readFileSync(path, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    function visit(node: ts.Node): void {
      if (ts.isCallExpression(node)) {
        const name = node.expression.getText(file);
        if (
          ["Number", "parseFloat", "parseInt", "Number.parseFloat", "Number.parseInt"].includes(
            name,
          )
        ) {
          failures.push(`${path}: ${name}`);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(file);
  }
  expect(failures).toEqual([]);
});
