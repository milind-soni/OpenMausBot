import { join } from "node:path";

type ContainerEnv = Partial<Pick<NodeJS.ProcessEnv, "DOCKER_HOST" | "CONTAINER_HOST" | "DOCKER_CONFIG" | "DOCKER_CONTEXT">>;

/** Test servers never see the developer's container daemon; a test that needs one opts in with OMB_TEST_ALLOW_CONTAINERS=1. */
export function noHostContainerEnv(home: string): ContainerEnv {
  if (process.env.OMB_TEST_ALLOW_CONTAINERS === "1") return {};
  return {
    DOCKER_HOST: `unix://${join(home, "no-docker.sock")}`,
    CONTAINER_HOST: `unix://${join(home, "no-podman.sock")}`,
    // A selected Docker context wins over DOCKER_HOST, so isolate its config and select the default context.
    DOCKER_CONFIG: join(home, ".docker"),
    DOCKER_CONTEXT: "default",
  };
}
