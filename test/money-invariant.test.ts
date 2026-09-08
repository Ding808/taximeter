import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { expect, test } from "vitest";
import { totalSchema, totals } from "../src/ledger/derive";
import { event } from "./helpers";

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sources(path) : /\.[cm]?[jt]sx?$/.test(path) ? [path] : [];
  });
}

test("derived totals may be wider than any individual authorization", () => {
  const amount = "9".repeat(78);
  const result = totals([event({ amount }), event({ amount })]);
  expect(result[0]?.amount).toBe((BigInt(amount) * 2n).toString());
  expect(totalSchema.safeParse(result[0]).success).toBe(true);
});

test("source never converts integer-string money through floating-point parsers", () => {
  const failures: string[] = [];
  for (const path of ["src", "ui"].flatMap(sources)) {
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
