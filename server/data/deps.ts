import type { ChartCompiler, ChartRenderer, DataEngine, VegaLiteValidator } from "./types.ts";
import { dataEngine as engine } from "./engine.ts";
import { compileChart as compile } from "./chart-compiler.ts";
import { validateVegaLite as validate } from "./vega-lite-validator.ts";
import { chartRenderer as renderer } from "./render.ts";

export const dataEngine: DataEngine = engine;
export const compileChart: ChartCompiler = compile;
export const validateVegaLite: VegaLiteValidator = validate;
export const chartRenderer: ChartRenderer = renderer;
