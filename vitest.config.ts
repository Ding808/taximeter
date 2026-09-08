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
    },
  },
});
