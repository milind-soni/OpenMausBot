import { afterEach, expect, it } from "vitest";
import { setLocale } from "@/lib/i18n";
import { updaterMessage } from "@/lib/updater";
import { connectionMessage } from "@/components/OrganizationSettings";

afterEach(() => setLocale("en"));

it("says the updater's own words in the app's language, and keeps a message main could not classify", () => {
  setLocale("pt-br");
  expect(updaterMessage({ status: "error", message: "Not enough disk space to prepare the update. Free some space, then try again.", messageCode: "disk" }))
    .toBe("Não há espaço em disco suficiente para preparar a atualização. Libere espaço e tente de novo.");
  const restart = { status: "error", retryable: false, message: "Not enough disk space… Quit and reopen OpenMausBot before trying the update again.", messageCode: "disk" } as const;
  expect(updaterMessage(restart)).toMatch(/Libere espaço e tente de novo\. Saia e abra o OpenMausBot de novo antes de tentar a atualização outra vez\.$/);
  expect(updaterMessage(restart, { restart: false })).toBe("Não há espaço em disco suficiente para preparar a atualização. Libere espaço e tente de novo.");
  expect(updaterMessage({ status: "error", message: "HttpError: 418" })).toBe("HttpError: 418");
  expect(updaterMessage(null)).toBeUndefined();
  setLocale("en");
  expect(updaterMessage({ status: "installing", message: "Restart is taking longer than expected. Quit and reopen OpenMausBot to finish the update.", messageCode: "slowRestart" }))
    .toBe("Restart is taking longer than expected. Quit and reopen OpenMausBot to finish the update.");
});

it("says the company connection's lines in the app's language, in order, and keeps a line that comes with no codes", () => {
  setLocale("pt-br");
  expect(connectionMessage({ message: "Disconnected on this computer. The portal was unreachable; …", messageCodes: ["disconnected", "portalUnreachable"] }))
    .toBe("Desconectado neste computador. Não foi possível acessar o portal; peça ao administrador para revogar este dispositivo lá também.");
  expect(connectionMessage({ message: "An older desktop's words." })).toBe("An older desktop's words.");
  expect(connectionMessage({ message: "Unknown.", messageCodes: ["somethingNew" as never] })).toBe("Unknown.");
});
