import { expect, it, vi } from "vitest";

import { DEFAULT_ADMIN_ORIGIN, organisationSignIn } from "./onboarding";

vi.mock("../../product.json", async (importOriginal) => {
  const real = await importOriginal<{ default: { services: Record<string, unknown> } }>();
  const product = { ...real.default, services: { ...real.default.services, adminPortal: null } };
  return { ...real, ...product, default: product };
});

it("offers no organization sign-in when the build names no portal", () => {
  expect(DEFAULT_ADMIN_ORIGIN).toBeNull();
  expect(organisationSignIn({ organization: { begin: () => {} } }, { hosted: false })).toBeUndefined();
});
