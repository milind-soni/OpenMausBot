import { afterEach, expect, it } from "vitest";

import { localizeComputerProblem } from "./computer-messages";
import { setLocale } from "./i18n";

afterEach(() => setLocale("en"));

it("words the container runtime problems the server reports, and keeps any other text", () => {
  expect(localizeComputerProblem("Install a supported container runtime first")).toBe("Install a supported container runtime first");
  expect(localizeComputerProblem("Start docker first")).toBe("Start docker first");
  setLocale("pt-br");
  expect(localizeComputerProblem("Install a supported container runtime first")).toBe("Instale primeiro um ambiente de execução de contêineres compatível");
  expect(localizeComputerProblem("Start podman first")).toBe("Inicie podman primeiro");
  expect(localizeComputerProblem("Something new")).toBe("Something new");
});
