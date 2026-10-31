import { describe, expect, it } from "vitest";
import { setLocale } from "@/lib/i18n";
import { localizedContainerProblem } from "@/lib/vm-problem";

describe("localizedContainerProblem", () => {
  it("localizes the prepare-image wire text from the server", () => {
    setLocale("it");
    expect(localizedContainerProblem("Prepare the Cua desktop image with Driver 0.37.0")).toBe(
      "Prepara l'immagine desktop Cua con Driver 0.37.0",
    );
    setLocale("en");
    expect(localizedContainerProblem("Prepare the Cua desktop image with Driver 0.37.0")).toBe(
      "Prepare the Cua desktop image with Driver 0.37.0",
    );
  });

  it("passes through unrecognized problems", () => {
    expect(localizedContainerProblem("Something else")).toBe("Something else");
    expect(localizedContainerProblem(null)).toBeNull();
    expect(localizedContainerProblem(undefined)).toBeNull();
  });
});
