import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
vi.mock("./pair/ServerUnavailable", () => ({ ServerUnavailable: () => "Server unavailable", LoadFailed: () => "Load failed" }));
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

it("offers a new visitor the email sign-in page", async () => {
  fixture.session.mockResolvedValue({ kind: "unauthenticated", error: "403" });
  expect(await open("/swarm/")).toBe("Email sign-in form");
});

it("says the server cannot be reached instead of opening an empty workspace", async () => {
  fixture.session.mockResolvedValue({ kind: "unreachable", error: "502 Bad Gateway" });
  expect(await open("/swarm/")).toBe("Server unavailable");
  expect(fixture.environment).not.toHaveBeenCalled();
});

it("keeps the desktop app on the workspace while its own server starts", async () => {
  vi.stubGlobal("window", { addEventListener: vi.fn(), ogb: { platform: "darwin" } });
  fixture.session.mockResolvedValue({ kind: "unreachable", error: "fetch failed" });
  expect(await open("/swarm/")).toBe("Swarm app");
});

it("asks for the sign-in options again before sending a visitor to access codes", async () => {
  fixture.session.mockResolvedValue({ kind: "unauthenticated", error: "403" });
  fixture.environment.mockResolvedValueOnce(null).mockResolvedValueOnce({ capabilities: { accountSignIn: true } });
  vi.stubGlobal("location", { pathname: "/swarm/", hash: "", search: "" });
  await import("./main");
  await vi.waitFor(() => expect(fixture.render).toHaveBeenCalledOnce(), { timeout: 3000 });
  expect(renderToStaticMarkup(fixture.render.mock.calls[0][0])).toBe("Email sign-in form");
  expect(fixture.environment).toHaveBeenCalledTimes(2);
});

describe("when the workspace code fails to load", () => {
  beforeEach(() => {
    vi.doMock("./App", () => { throw new Error("Failed to fetch dynamically imported module"); });
  });
  afterEach(() => { vi.doMock("./App", () => ({ default: () => "Swarm app" })); });

  it("loads the page again once to pick up a new build", async () => {
    const reload = vi.fn();
    const stored = new Map<string, string>();
    vi.stubGlobal("sessionStorage", { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) });
    vi.stubGlobal("location", { pathname: "/swarm/", hash: "", search: "", reload });
    await import("./main");
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(fixture.render).not.toHaveBeenCalled();
  });

  it("does not trade the page for the browser's offline error", async () => {
    const reload = vi.fn();
    vi.stubGlobal("navigator", { onLine: false });
    vi.stubGlobal("sessionStorage", { getItem: () => null, setItem: vi.fn() });
    vi.stubGlobal("location", { pathname: "/swarm/", hash: "", search: "", reload });
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await import("./main");
    await vi.waitFor(() => expect(fixture.render).toHaveBeenCalledOnce());
    expect(renderToStaticMarkup(fixture.render.mock.calls[0][0])).toBe("Load failed");
    expect(reload).not.toHaveBeenCalled();
    logged.mockRestore();
  });

  it("explains instead of reloading again within a minute", async () => {
    const reload = vi.fn();
    vi.stubGlobal("sessionStorage", { getItem: () => String(Date.now() - 5_000), setItem: vi.fn() });
    vi.stubGlobal("location", { pathname: "/swarm/", hash: "", search: "", reload });
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await import("./main");
    await vi.waitFor(() => expect(fixture.render).toHaveBeenCalledOnce());
    expect(renderToStaticMarkup(fixture.render.mock.calls[0][0])).toBe("Load failed");
    expect(reload).not.toHaveBeenCalled();
    logged.mockRestore();
  });
});
