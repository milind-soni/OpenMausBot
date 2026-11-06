import type { FleetDeps, FleetInput } from "./fleet-cli.ts";
import type { CreateBrand, FleetLayout, FleetRegistry, FleetStep } from "./fleet.ts";
import type { FleetReseller } from "./fleet-reseller.ts";

export function resolveCreateBrandJson(input: Pick<FleetInput, "brandFile" | "brandJson"> & { registry: FleetRegistry }, deps: Pick<FleetDeps, "readText">): string | undefined {
  const brandJson = input.brandJson ?? (input.brandFile ? deps.readText(input.brandFile) : undefined);
  if (input.brandFile && brandJson === null) throw new Error(`${input.brandFile} not found`);
  if (brandJson) JSON.parse(brandJson);
  return brandJson ?? undefined;
}

export function planCreateBrand(_input: Pick<FleetInput, "brandFile" | "brandJson"> & { registry: FleetRegistry; layout: FleetLayout; slug: string }, _deps: Pick<FleetDeps, "readText" | "readBytes">): CreateBrand {
  return { steps: [], env: [] };
}

export function brandCreateNotes(_input: { registry: FleetRegistry; licenseKey?: string }): string[] {
  return [];
}

export function planFleetBrand(_input: FleetInput, _deps: FleetDeps): FleetStep[] {
  throw new Error("fleet brand is not implemented yet");
}

export function effectiveBrand(reseller: Pick<FleetReseller, "name">, brandDefault: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  return { name: reseller.name, ...brandDefault, ...override };
}

export function omitBrandAssets<T extends object>(view: T): T {
  return view;
}

export function brandInputFromBody(base: FleetInput, _body: Record<string, unknown>, slug: string | undefined): FleetInput {
  return { ...base, action: "brand", slug, brandDefault: slug === undefined };
}
