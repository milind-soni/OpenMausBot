import { afterEach, expect, it } from "vitest";
import { prepareConnectionAuthConfigs } from "./composio.ts";

const savedProvider = process.env.OMB_CONNECTOR_PROVIDER;
const savedUrl = process.env.OMB_OPENCONNECTOR_URL;
const savedToken = process.env.OMB_OPENCONNECTOR_ADMIN_TOKEN;

afterEach(() => {
  if (savedProvider === undefined) delete process.env.OMB_CONNECTOR_PROVIDER;
  else process.env.OMB_CONNECTOR_PROVIDER = savedProvider;
  if (savedUrl === undefined) delete process.env.OMB_OPENCONNECTOR_URL;
  else process.env.OMB_OPENCONNECTOR_URL = savedUrl;
  if (savedToken === undefined) delete process.env.OMB_OPENCONNECTOR_ADMIN_TOKEN;
  else process.env.OMB_OPENCONNECTOR_ADMIN_TOKEN = savedToken;
});

it("returns HTTP 400 when authConfigId is sent to OpenConnector", async () => {
  process.env.OMB_CONNECTOR_PROVIDER = "openconnector";
  process.env.OMB_OPENCONNECTOR_URL = "https://connector.example.test";
  process.env.OMB_OPENCONNECTOR_ADMIN_TOKEN = "0".repeat(64);
  await expect(prepareConnectionAuthConfigs({}, [{ slug: "github", authConfigId: "ac_test" }]))
    .rejects.toMatchObject({ status: 400, message: expect.stringContaining("Composio") });
});
