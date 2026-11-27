// The bots' sandbox row in Settings, Updates, on a self-hosted server (src/components/BotSandboxRow.tsx): its words.
import { mustPassFailures, type BotSandboxStatus } from "../../shared/bot-sandbox";
import { t } from "./i18n";

/** What puts the sandbox on: the installer, run again on the server. */
export function sandboxInstallCommand(domain: string): string {
  return `curl -fsSL https://raw.githubusercontent.com/milind-soni/OpenMausBot/main/deploy/install.sh | sudo sh -s -- --domain ${domain || "maus.example.com"}`;
}

/** The row's words: what the sandbox does here now, why when it is not on, and the one thing that turns it on. A check
 * that only warns is shown, quietly; one that must pass is red, and with `required` it refuses bots' commands. */
export function botSandboxLines(status: BotSandboxStatus, domain: string): { value: string; detail: string; tone: "ok" | "danger" | "quiet"; command?: string } {
  const failed = status.checks?.failed ?? [];
  const must = mustPassFailures(failed);
  const warned = failed.filter((id) => !must.includes(id));
  const warning = warned.length ? ` ${t("botSandbox.checksWarned", { warned: warned.join(", ") })}` : "";
  if (status.state === "on") {
    const checks = status.checks;
    if (checks && must.length) return { value: t("botSandbox.on"), detail: t("botSandbox.checksFailed", { failed: must.join(", ") }), tone: "danger" };
    return { value: t("botSandbox.on"), detail: `${t("botSandbox.onDetail")}${checks ? ` ${t("botSandbox.checks", { passed: checks.passed, total: checks.total })}` : ""}${warning}`, tone: "ok" };
  }
  const why = status.reason === "switched-off" ? t("botSandbox.reason.switchedOff")
    : status.reason === "no-bwrap" ? t("botSandbox.reason.noBwrap")
      : status.reason === "not-linux" ? t("botSandbox.reason.notLinux")
        : status.reason === "start-failed" ? t("botSandbox.reason.startFailed")
          : status.reason === "self-check-failed" ? t("botSandbox.reason.selfCheckFailed", { failed: (must.length ? must : ["no-answer"]).join(", ") })
            : t("botSandbox.reason.notPrepared");
  const command = status.reason === "userns-refused" || status.reason === "switched-off" ? sandboxInstallCommand(domain) : undefined;
  if (status.state === "refusing") return { value: t("botSandbox.refusing"), detail: `${t("botSandbox.refusingDetail")} ${why}`, tone: "danger", command };
  return { value: t("botSandbox.off"), detail: `${t("botSandbox.offDetail")} ${why}`, tone: status.reason === "switched-off" ? "quiet" : "danger", command };
}
