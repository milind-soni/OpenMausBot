import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

/** One offline bundle inside a unique-origin sandbox, also in dev. Defining
 * production explicitly excludes OpenUI's CDN-loaded development inspector. */
export function interactiveRuntimePlugin(): Plugin {
  return {
    name: "interactive-runtime",
    handleHotUpdate(ctx) {
      if (
        !/\/(src\/interactive\/runtime\.tsx|shared\/interactive-reply\.ts)$/.test(
          ctx.file.replaceAll("\\", "/"),
        )
      )
        return;
      const module = ctx.server.moduleGraph.getModuleById("\0interactive-runtime");
      if (module) ctx.server.moduleGraph.invalidateModule(module);
      ctx.server.ws.send({ type: "full-reload" });
      return [];
    },
    resolveId(id) {
      if (id === "virtual:interactive-runtime") return "\0interactive-runtime";
    },
    async load(id) {
      if (id !== "\0interactive-runtime") return;
      this.addWatchFile(fileURLToPath(new URL("../src/interactive/runtime.tsx", import.meta.url)));
      this.addWatchFile(fileURLToPath(new URL("../shared/interactive-reply.ts", import.meta.url)));
      const result = await build({
        entryPoints: [fileURLToPath(new URL("../src/interactive/runtime.tsx", import.meta.url))],
        bundle: true,
        write: false,
        format: "iife",
        platform: "browser",
        minify: true,
        define: { "process.env.NODE_ENV": '"production"' },
      });
      return `export default ${JSON.stringify(result.outputFiles[0]!.text)};`;
    },
  };
}
