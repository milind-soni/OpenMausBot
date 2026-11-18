import { afterEach, expect, it } from "vitest";
import { setLocale } from "@/lib/i18n";
import { updaterMessage } from "@/lib/updater";
import { connectionMessage } from "@/components/OrganizationSettings";

afterEach(() => setLocale("en"));

it("translates fixed native update words at render time, retaining raw diagnostics and exact English", () => {
  const state = { status: "handed-off", message: "The install did not finish: The install took too long.", messageKey: "native.update.installFailed", messageParams: { reason: "The install took too long.", timedOut: "true" } } as const;
  expect(updaterMessage(state)).toBe(state.message);
  setLocale("pt-br");
  expect(updaterMessage(state)).toBe("A instalação não terminou. Motivo: A instalação demorou demais.");
  expect(updaterMessage({ ...state, messageParams: { reason: "E: dpkg lock" } })).toBe("A instalação não terminou. Motivo: E: dpkg lock");
  expect(updaterMessage({ ...state, messageParams: {} })).toBe(state.message);
  expect(updaterMessage({ ...state, messageKey: "native.update.future" })).toBe(state.message);
  expect(updaterMessage({ ...state, messageKey: "native.lend.terminal.title" })).toBe(state.message);
  expect(updaterMessage({ status: "installing", message: "Installing the update. Enter your password if asked.", messageKey: "native.update.installing" })).toBe("Instalando a atualização. Digite a senha se ela for solicitada.");
  const failed = { status: "error", message: "Couldn't check for updates. Offline detail", messageKey: "native.update.checkFailed", messageParams: { error: "Offline detail" } } as const;
  expect(updaterMessage(failed)).toBe("Não foi possível buscar atualizações. Offline detail");
  expect(updaterMessage({ ...failed, messageCode: "network" })).toContain("Não foi possível buscar atualizações.");
  expect(updaterMessage({ ...failed, messageCode: "network" })).not.toContain("Offline detail");
  setLocale("en");
  expect(updaterMessage({ ...failed, messageCode: "network" })).toBe(failed.message);
});

it("says the updater's own words in the app's language, and keeps a message main could not classify", () => {
  setLocale("pt-br");
  expect(updaterMessage({ status: "error", message: "Not enough disk space to prepare the update. Free some space, then try again.", messageCode: "disk" }))
    .toBe("Não há espaço em disco suficiente para preparar a atualização. Libere espaço e tente novamente.");
  const restart = { status: "error", retryable: false, message: "Not enough disk space… Quit and reopen OpenMausBot before trying the update again.", messageCode: "disk" } as const;
  expect(updaterMessage(restart)).toMatch(/Libere espaço e tente novamente\. Saia e abra o OpenMausBot de novo antes de tentar a atualização novamente\.$/);
  expect(updaterMessage(restart, { restart: false })).toBe("Não há espaço em disco suficiente para preparar a atualização. Libere espaço e tente novamente.");
  expect(updaterMessage({ status: "error", message: "HttpError: 418" })).toBe("HttpError: 418");
  expect(updaterMessage(null)).toBeUndefined();
  setLocale("en");
  expect(updaterMessage({ status: "installing", message: "Restart is taking longer than expected. Quit and reopen OpenMausBot to finish the update.", messageCode: "slowRestart" }))
    .toBe("Restart is taking longer than expected. Quit and reopen OpenMausBot to finish the update.");
});

it("says the company connection's lines in the app's language, in order, and keeps a line that comes with no codes", () => {
  setLocale("pt-br");
  expect(connectionMessage({ message: "Disconnected on this computer. The portal was unreachable; …", messageCodes: ["disconnected", "portalUnreachable"] }))
    .toBe("Desconectado neste computador. Não foi possível acessar o portal. Peça ao administrador para revogar o acesso deste dispositivo lá também.");
  expect(connectionMessage({ message: "An older desktop's words." })).toBe("An older desktop's words.");
  expect(connectionMessage({ message: "Unknown.", messageCodes: ["somethingNew" as never] })).toBe("Unknown.");
});
