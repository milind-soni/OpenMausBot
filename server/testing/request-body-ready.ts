import { IncomingMessage } from "node:http";

const on = IncomingMessage.prototype.on;
IncomingMessage.prototype.on = function (event: string, listener: (...args: any[]) => void) {
  const result = on.call(this, event, listener);
  const id = this.headers["x-omb-fixture-body"];
  if (event === "data" && typeof id === "string") {
    delete this.headers["x-omb-fixture-body"];
    process.send?.({ reading: id });
  }
  return result;
};

const fetch = globalThis.fetch;
globalThis.fetch = (input, init) => String(input).startsWith("http://127.0.0.1:")
  ? fetch(input, init) : Promise.resolve(new Response("offline fixture", { status: 503 }));
