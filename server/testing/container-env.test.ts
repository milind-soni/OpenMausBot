import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { noHostContainerEnv } from "./container-env.ts";

describe("noHostContainerEnv", () => {
  it("points both container CLIs at sockets inside the throwaway home", () => {
    const home = join("tmp", "omb-test-home");
    expect(noHostContainerEnv(home)).toEqual({
      DOCKER_HOST: `unix://${join(home, "no-docker.sock")}`,
      CONTAINER_HOST: `unix://${join(home, "no-podman.sock")}`,
    });
  });

  it("leaves the runtime alone when a test opts in", () => {
    process.env.OMB_TEST_ALLOW_CONTAINERS = "1";
    try {
      expect(noHostContainerEnv("any-home")).toEqual({});
    } finally {
      delete process.env.OMB_TEST_ALLOW_CONTAINERS;
    }
  });
});
