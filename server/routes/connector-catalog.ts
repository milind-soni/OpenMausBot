// GET /api/connector-catalog: what the Connectors page lists. Never carries the relay token.
import { connectorCatalog } from "../connector-catalog.ts";
import { PASS, type RouteHandler } from "./table.ts";

export const connectorCatalogRoutes: RouteHandler = async ({ res, path, method, json }) => {
  if (method !== "GET" || path !== "/api/connector-catalog") return PASS;
  res.setHeader("cache-control", "no-store");
  json(res, 200, await connectorCatalog());
};
