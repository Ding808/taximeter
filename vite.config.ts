import { defineConfig } from "vite";

export default defineConfig({
  root: "ui",
  build: { outDir: "../dist/ui", emptyOutDir: true, sourcemap: false, target: "es2022" },
});
