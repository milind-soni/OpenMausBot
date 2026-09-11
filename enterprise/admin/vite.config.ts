import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  root: "web",
  build: { outDir: "../dist/web", emptyOutDir: true },
  test: { root: ".", include: ["tests/**/*.test.ts"], fileParallelism: false },
});
