import type { ChartCompiler, ChartRenderer, DataEngine, VegaLiteValidator } from "./types.ts";
import { dataEngine as engine } from "./engine.ts";
import { compileChart as compile } from "./chart-compiler.ts";

export const dataEngine: DataEngine = engine;
export const compileChart: ChartCompiler = compile;
// Vega, Vega-Lite and its JSON schema load at the first chart, not with the server.
export const validateVegaLite: VegaLiteValidator = async (spec) => (await import("./vega-lite-validator.ts")).validateVegaLite(spec);
export const chartRenderer: ChartRenderer = {
  svg: async (...args) => (await import("./render.ts")).chartRenderer.svg(...args),
  png: async (...args) => (await import("./render.ts")).chartRenderer.png(...args),
};
