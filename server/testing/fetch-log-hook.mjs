// Loaded only when OMB_TEST_FETCH_LOG names a file: each fetch URL is appended, so a fixture can show nothing left loopback.
import { appendFileSync } from "node:fs";

const file = process.env.OMB_TEST_FETCH_LOG;
if (file) {
  const original = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input, init) => {
    try {
      const url = input instanceof Request ? input.url : String(input);
      appendFileSync(file, `${url.split(/[?#]/)[0]}\n`);
    } catch {
      // A test that cannot record a URL still has to make the request.
    }
    return original(input, init);
  };
}
