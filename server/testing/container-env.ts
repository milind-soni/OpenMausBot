import { join } from "node:path";

/** Test servers never see the developer's container daemon; a test that needs one opts in with OMB_TEST_ALLOW_CONTAINERS=1. */
export function noHostContainerEnv(home: string): Partial<Pick<NodeJS.ProcessEnv, "DOCKER_HOST" | "CONTAINER_HOST">> {
  if (process.env.OMB_TEST_ALLOW_CONTAINERS === "1") return {};
  return {
    DOCKER_HOST: `unix://${join(home, "no-docker.sock")}`,
    CONTAINER_HOST: `unix://${join(home, "no-podman.sock")}`,
  };
}
