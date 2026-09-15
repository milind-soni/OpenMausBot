import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  base: "./",
  publicDir: false,
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  plugins: [react(), tailwindcss(), {
    name: "standalone-avatar-demo",
    enforce: "post",
    generateBundle(_options, bundle) {
      for (const id of this.getModuleIds()) {
        if (/\/(?:src\/(?:state|api|telemetry)\/|server\/)|posthog/.test(id)) {
          this.error(`The static avatar demo must not import backend, store or telemetry modules: ${id}`);
        }
      }
      const html = bundle["avatar-demo.html"];
      if (html) {
        html.fileName = "index.html";
        bundle["index.html"] = html;
        delete bundle["avatar-demo.html"];
      }
    },
  }],
  build: {
    outDir: "dist-avatar-demo",
    modulePreload: false,
    rollupOptions: { input: fileURLToPath(new URL("./avatar-demo.html", import.meta.url)) },
  },
});
