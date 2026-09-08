import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    {
      name: "sql-text",
      transform(code, id) {
        if (id.endsWith(".sql")) return `export default ${JSON.stringify(code)}`;
      },
    },
  ],
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 20000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "json-summary"],
      thresholds: {
        "src/ledger/**": { statements: 90, branches: 90, functions: 90, lines: 90 },
        "src/policy/**": { statements: 90, branches: 90, functions: 90, lines: 90 },
      },
    },
  },
});
