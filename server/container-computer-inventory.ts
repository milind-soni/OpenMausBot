import { CONTAINER, MANAGED_LABEL, sh, type CommandRunner, type Runtime } from "./container-computer.ts";

/** Enumerate managed per-bot names so source changes cannot hide a container
 * whose bot record no longer exists. Unknown managed names fail closed. */
export async function containerComputerManagedPerBotNames(
  runtime: Runtime,
  runner: CommandRunner = sh,
): Promise<string[] | null> {
  try {
    const { stdout } = await runner(
      runtime,
      ["ps", "-a", "--filter", `label=${MANAGED_LABEL}=1`, "--format", "{{.Names}}"],
      8_000,
    );
    const names = [...new Set(stdout.split(/\r?\n/).map((name) => name.trim()).filter(Boolean))];
    const pattern = new RegExp(`^${CONTAINER}-[0-9a-f]{16}$`);
    const perBotNames = names.filter((name) => name !== CONTAINER);
    return perBotNames.every((name) => pattern.test(name)) ? perBotNames : null;
  } catch {
    return null;
  }
}
