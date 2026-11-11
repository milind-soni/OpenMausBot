// @vitest-environment node
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { metadataDocumentClient, mcpReadonlyResource, OAuthError, protectedResourceMetadata, requestClientId, requestedResource, setMetadataDocumentNetwork } from "./mcp-oauth";

// What Claude.ai and ChatGPT custom connectors need beyond plain DCR: client ID metadata documents, Basic client
// credentials, and the read-only resource.

beforeEach(() => { vi.stubEnv("ORIGIN_PUBLIC_URL", "https://origin.test"); });
afterEach(() => { vi.unstubAllEnvs(); setMetadataDocumentNetwork(null); });

const chatgpt = "https://chatgpt.com/oauth/client.json";
const serve = (body: unknown) => setMetadataDocumentNetwork(async () => new Response(JSON.stringify(body)), async () => true);

test("a client ID metadata document is used only when it names itself and lists usable redirects", async () => {
  serve({ client_id: chatgpt, client_name: "ChatGPT", redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"] });
  expect(await metadataDocumentClient(chatgpt)).toEqual({ name: "ChatGPT", redirects: ["https://chatgpt.com/connector_platform_oauth_redirect"] });
  serve({ client_id: "https://evil.test/client.json", redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"] });
  expect(await metadataDocumentClient(chatgpt)).toBeNull();
  serve({ client_id: chatgpt, redirect_uris: ["http://evil.test/cb"] });
  expect(await metadataDocumentClient(chatgpt)).toBeNull();
  setMetadataDocumentNetwork(async () => new Response("{}"), async () => false);
  expect(await metadataDocumentClient(chatgpt)).toBeNull();
  expect(await metadataDocumentClient("http://chatgpt.com/oauth/client.json")).toBeNull();
});

test("client_id comes from the form or from HTTP Basic credentials", () => {
  expect(requestClientId(new URLSearchParams({ client_id: "abc" }), "Basic eDp5")).toBe("abc");
  expect(requestClientId(new URLSearchParams(), `Basic ${Buffer.from("client-1:ignored").toString("base64")}`)).toBe("client-1");
  expect(requestClientId(new URLSearchParams(), "Bearer x")).toBe("");
});

test("the read-only endpoint is a known resource with its own metadata; others are refused", () => {
  expect(requestedResource(null)).toBe("https://origin.test/api/mcp");
  expect(requestedResource("https://origin.test/api/mcp/readonly/")).toBe(mcpReadonlyResource());
  expect(() => requestedResource("https://elsewhere.test/api/mcp")).toThrow(OAuthError);
  expect(protectedResourceMetadata(mcpReadonlyResource())).toMatchObject({ resource: "https://origin.test/api/mcp/readonly", scopes_supported: ["origin:read"], authorization_servers: ["https://origin.test"] });
});
