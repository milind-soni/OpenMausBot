// Imported only by the isolated verification launcher, never production.
// Keep the real provider URL fixed; redirect its transport inside this child.
const origin = process.env.OMB_TEST_ORGO_API;
if (!origin || !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(origin)) {
  throw new Error("Orgo verification requires an explicit loopback HTTP provider");
}
new URL(origin); // Reject invalid port numbers before any request.
const original = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.origin !== "https://www.orgo.ai" || (url.pathname !== "/api" && !url.pathname.startsWith("/api/"))) {
    return original(input, init);
  }
  const target = origin + url.pathname.slice(4) + url.search;
  return original(input instanceof Request ? new Request(target, input) : target, init);
};
