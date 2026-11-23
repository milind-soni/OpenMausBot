import { vi } from "vitest";

/**
 * Tests run as a build that has every hosted service, on hosts that never resolve, so the code behind each service
 * stays covered. A test of a build without one mocks "product.json" again with that service null.
 */
export const TEST_SERVICES = {
  analytics: { token: "phc_test", host: "https://analytics.example.test" },
  cloud: "https://cloud.example.test",
  accounts: "https://accounts.example.test",
  adminPortal: "https://admin.example.test",
  composioBroker: "https://composio.example.test",
  problemReports: "https://reports.example.test",
  announcements: "https://announcements.example.test",
  modelManifest: "https://models.example.test/manifest.json",
  teamLibrary: { repository: "https://github.com/example/team-library", rawRoot: "https://raw.example.test/example/team-library/main" },
};

vi.mock("../../product.json", async (importOriginal) => {
  const real = await importOriginal<{ default: Record<string, unknown> }>();
  const product = { ...real.default, services: TEST_SERVICES };
  return { ...real, ...product, default: product };
});
