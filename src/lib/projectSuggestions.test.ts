import { describe, expect, it } from "vitest";
import {
  BROWSER_HOST_FOLDER_HINT,
  BROWSER_SUGGESTED_FOLDERS,
  applySuggestedFolder,
  childPath,
  getSuggestedProjectFolders,
  parentFolderPath,
  projectSourceLabel,
  repositoryFolderName,
} from "./projectSuggestions";

describe("projectSuggestions helpers", () => {
  it("provides safe home-relative suggested folders and appends unique existing parent folders", () => {
    expect(getSuggestedProjectFolders(null)).toEqual([...BROWSER_SUGGESTED_FOLDERS]);
    expect(BROWSER_HOST_FOLDER_HINT).toContain("host computer");

    const withProjects = getSuggestedProjectFolders([
      { path: "/Users/alex/Dev/studio-app" },
      { path: "/Users/alex/Dev/another-app" },
      { path: "/Users/alex/Clients/site" },
    ]);
    expect(withProjects).toEqual([
      ...BROWSER_SUGGESTED_FOLDERS,
      "/Users/alex/Dev",
      "/Users/alex/Clients",
    ]);
  });

  it("extracts repository names and builds destination paths when clicking a chip in clone mode", () => {
    expect(repositoryFolderName("https://github.com/acme/wave-editor.git")).toBe("wave-editor");
    expect(parentFolderPath("/Users/alex/Projects/wave-editor")).toBe("/Users/alex/Projects");
    expect(childPath("~/Projects/", "wave-editor")).toBe("~/Projects/wave-editor");
    expect(childPath("C:\\Users\\alex\\Projects\\", "wave-editor", "win32")).toBe(
      "C:\\Users\\alex\\Projects\\wave-editor",
    );

    expect(
      applySuggestedFolder("~/Projects", {
        mode: "existing",
        repositoryUrl: "https://github.com/acme/wave-editor",
      }),
    ).toBe("~/Projects");

    expect(
      applySuggestedFolder("~/Projects", {
        mode: "clone",
        repositoryUrl: "https://github.com/acme/wave-editor.git",
      }),
    ).toBe("~/Projects/wave-editor");

    expect(
      applySuggestedFolder("~/Projects", {
        mode: "clone",
        repositoryUrl: "",
      }),
    ).toBe("~/Projects");
  });

  it("returns plain-language source labels", () => {
    expect(projectSourceLabel({ source: "github" })).toBe("From GitHub");
    expect(projectSourceLabel({ source: "created" })).toBe("New project folder");
    expect(projectSourceLabel({ source: "existing" })).toBe("Folder on this computer");
  });
});
