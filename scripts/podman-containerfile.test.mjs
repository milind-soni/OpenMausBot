import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const buildCopies = (text) =>
  [...text.matchAll(/^COPY --from=build (?:--chown=\S+ )?(\S+) (\S+)$/gm)].map(([, from, to]) => `${from} ${to}`);

describe("Podman image build", () => {
  it("ships the bundled skills, as the Docker server image does", () => {
    const server = read("../Dockerfile").split(/^FROM runtime AS server$/m)[1];
    expect(server).toBeDefined();
    expect(buildCopies(server)).toContain("/src/skills ./skills");
    expect(buildCopies(read("../deploy/podman/Containerfile"))).toContain("/src/skills ./skills");
  });
});
