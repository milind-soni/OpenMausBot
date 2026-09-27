import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  render: vi.fn(),
  session: vi.fn(),
  loginToken: vi.fn(),
  environment: vi.fn(),
}));

vi.mock("react-dom/client", () => ({ createRoot: () => ({ render: fixture.render }) }));
vi.mock("./App", () => ({ default: () => "Swarm app" }));
vi.mock("./pair/LoginPage", () => ({ LoginPage: () => "Email sign-in form" }));
vi.mock("./pair/PairPage", () => ({ PairPage: () => "Access-code form" }));
vi.mock("./lib/brand", () => ({ bootstrapBrand: async () => undefined }));
vi.mock("./lib/skins", () => ({ applySkin: () => undefined, readSkin: () => "dark" }));
vi.mock("./lib/session", async (original) => ({
  ...await original<typeof import("./lib/session")>(),
  readSessionState: fixture.session,
  takeLoginTokenFromLocation: fixture.loginToken,
  readEnvironment: fixture.environment,
  takePairingCodeFromLocation: () => null,
  takeInvitedEmailFromLocation: () => null,
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv("BASE_URL", "/swarm/");
  vi.stubGlobal("window", { addEventListener: vi.fn() });
  vi.stubGlobal("document", { getElementById: () => ({}) });
  fixture.loginToken.mockReturnValue(null);
  fixture.session.mockResolvedValue({ kind: "session", scopes: ["client"] });
  fixture.environment.mockResolvedValue({ capabilities: { accountSignIn: true } });
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

async function open(pathname: string) {
  vi.stubGlobal("location", { pathname, hash: "", search: "" });
  await import("./main");
  await vi.waitFor(() => expect(fixture.render).toHaveBeenCalledOnce());
  return renderToStaticMarkup(fixture.render.mock.calls[0][0]);
}

it.each(["/swarm/sign-in", "/swarm/sign-in/"])("offers email sign-in at %s even with an existing member session", async path => {
  expect(await open(path)).toBe("Email sign-in form");
});

it("opens the explicit sign-in page without a session", async () => {
  fixture.session.mockResolvedValue({ kind: "unauthenticated", error: "401" });
  expect(await open("/swarm/sign-in")).toBe("Email sign-in form");
});

it("keeps an existing member's ordinary Swarm visit in the app", async () => {
  expect(await open("/swarm/")).toBe("Swarm app");
});

it("still handles emailed sign-in links before an existing session", async () => {
  fixture.loginToken.mockReturnValue("fixture-login-token");
  expect(await open("/swarm/")).toBe("Email sign-in form");
});

it("keeps access-code links on their existing page", async () => {
  expect(await open("/swarm/pair")).toBe("Access-code form");
});
