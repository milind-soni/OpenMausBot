import { readFileSync } from "node:fs";

import { writeFileAtomic } from "../atomic.ts";

export const RUN_COMPUTER_MEMORY_MAX = 500;

/** Which routines' runs have used a cloud computer, kept in one small file so that a restarted server still knows. */
export function runComputerMemory(file: string) {
  return {
    load(): string[] {
      try {
        const saved: unknown = JSON.parse(readFileSync(file, "utf8"));
        return Array.isArray(saved) ? saved.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 200).slice(-RUN_COMPUTER_MEMORY_MAX) : [];
      } catch {
        return [];
      }
    },
    /** A save that fails is made up for by the next one. */
    save(ids: readonly string[]): void {
      try {
        writeFileAtomic(file, JSON.stringify(ids.slice(-RUN_COMPUTER_MEMORY_MAX)));
      } catch {
        return;
      }
    },
  };
}
