import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { noHostContainerEnv } from "./container-env.ts";

const original = process.env.OMB_TEST_ALLOW_CONTAINERS;

function withAllowContainers(value: string | undefined, check: () => void): void {
  if (value === undefined) delete process.env.OMB_TEST_ALLOW_CONTAINERS;
  else process.env.OMB_TEST_ALLOW_CONTAINERS = value;
  try {
    check();
  } finally {
    if (original === undefined) delete process.env.OMB_TEST_ALLOW_CONTAINERS;
    else process.env.OMB_TEST_ALLOW_CONTAINERS = original;
  }
}

describe("noHostContainerEnv", () => {
  it("points both container CLIs at sockets inside the throwaway home", () => {
    withAllowContainers(undefined, () => {
      const home = join("tmp", "omb-test-home");
      expect(noHostContainerEnv(home)).toEqual({
        DOCKER_HOST: `unix://${join(home, "no-docker.sock")}`,
        CONTAINER_HOST: `unix://${join(home, "no-podman.sock")}`,
        DOCKER_CONFIG: join(home, ".docker"),
        DOCKER_CONTEXT: "default",
      });
    });
  });

  it("leaves the runtime alone when a test opts in", () => {
    withAllowContainers("1", () => {
      expect(noHostContainerEnv("any-home")).toEqual({});
    });
  });
});
