// Loaded with --import in isolated fixtures: moves the clock long-waits.ts reads, and nothing else, by the milliseconds in
// the file OMB_TEST_WAIT_CLOCK names, so a fixture can make a question a day old without moving sessions or schedules.
import { registerHooks } from "node:module";

const file = process.env.OMB_TEST_WAIT_CLOCK;
if (file) {
  const target = new URL("../host/long-waits.ts", import.meta.url).href;
  const seam = "export const waitNow = () => Date.now();";
  registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      if (url !== target) return result;
      const source = String(result.source);
      if (source.split(seam).length !== 2) throw new Error("The wait clock seam changed");
      return { ...result, source: source.replace(seam, `export const waitNow = () => Date.now() + Number(process.getBuiltinModule("node:fs").readFileSync(${JSON.stringify(file)}, "utf8"));`) };
    },
  });
}
