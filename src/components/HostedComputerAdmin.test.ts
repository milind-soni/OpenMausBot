import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { hostedComputersStatus } from "../../shared/hosted-computers";

const state = vi.hoisted(() => ({ config: { isProductOwner: true, adminGate: { pinRequired: false },
  hostedComputers: { orgo: { enabled: false, configured: true }, daytona: { enabled: true, configured: true } } } }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state }) }));
vi.mock("@/lib/api-client", () => ({ api: vi.fn() }));
import { HostedComputerAdmin } from "./HostedComputerAdmin";
import { CloudBackendPicker } from "./CloudBackendPicker";

it("shows setup and cost boundaries without rendering a saved credential", () => {
  const initial = hostedComputersStatus({ orgo: { enabled: true, apiKey: "SECRET_KEY", workspaceId: "workspace-a" } });
  const html = renderToStaticMarkup(createElement(HostedComputerAdmin, { initial }));
  expect(html).toContain("Orgo API key"); expect(html).toContain("Daytona API key");
  expect(html).toContain('type="password"'); expect(html).not.toContain("SECRET_KEY");
  expect(html).toContain("Leave blank to keep the saved key");
  expect(html).toContain("without creating a computer");
  expect(html).toContain("not yet charged to member credits");
});

it("offers only configured, enabled providers to owners and keeps setup out of member controls", () => {
  const render = () => renderToStaticMarkup(createElement(CloudBackendPicker, { value: "daytona", vpsSupported: false, onChange: vi.fn() }));
  expect(render()).toMatch(/<button[^>]*disabled=""[^>]*>Orgo<\/button>/);
  expect(render()).toMatch(/<button[^>]*aria-pressed="true"[^>]*>Daytona<\/button>/);
  state.config.isProductOwner = false;
  const member = render();
  expect(member).not.toContain("API key"); expect(member).not.toContain("Daytona"); expect(member).not.toContain("<button");
});
