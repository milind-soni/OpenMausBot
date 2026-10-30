// The saved servers' file (environments.json): read back with each local environment's folder checked, written whole
// through a temporary file so a crash never leaves half a list.
import environmentsModule from "./environments.cjs";

const { LOCAL_ID, parseEnvironments, serializeEnvironments } = environmentsModule;

/**
 * @param {{ file(): string, fs: typeof import("node:fs"), path: typeof import("node:path"), log?(line: string): void }} deps
 */
export function createEnvironmentsFile({ file, fs, path, log = () => {} }) {
  return {
    read() {
      try {
        const state = parseEnvironments(fs.readFileSync(file(), "utf8"));
        return {
          ...state,
          environments: state.environments.map((entry) =>
            entry.kind === "local" ? { ...entry, missing: !fs.existsSync(entry.dataDir) } : { ...entry, missing: false }),
        };
      } catch {
        return { environments: [], activeId: LOCAL_ID };
      }
    },
    write(state) {
      const target = file();
      const temporary = `${target}.${process.pid}.tmp`;
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(temporary, serializeEnvironments(state), { mode: 0o600 });
        fs.renameSync(temporary, target);
      } catch (error) {
        try { fs.rmSync(temporary, { force: true }); } catch {}
        log(`environments save failed: ${error?.message ?? error}`);
        throw new Error("Could not save server connections on this computer. Please try again.");
      }
    },
  };
}
