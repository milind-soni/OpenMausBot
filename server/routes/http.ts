// Shared HTTP plumbing for the route modules extracted from index.ts.
// json/readBody have one definition, in ../http.ts; it is re-exported here
// so index.ts and every route module use the same helpers.
export { json, readBody } from "../http.ts";

/** Per-request dispatch values the extracted route handlers read. */
export type RouteContext = {
  method: string;
  path: string;
  url: URL;
};
