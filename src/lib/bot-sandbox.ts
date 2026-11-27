// The bots' sandbox row in Settings, Updates, on a self-hosted server (src/components/BotSandboxRow.tsx): its words.
import type { BotSandboxStatus } from "../../shared/bot-sandbox";
import { t } from "./i18n";

/** What puts the sandbox on: the installer, run again on the server. */
export function sandboxInstallCommand(domain: string): string {
  return `curl -fsSL https://raw.githubusercontent.com/milind-soni/OpenMausBot/main/deploy/install.sh | sudo sh -s -- --domain ${domain || "maus.example.com"}`;
}

/** The row's words: what the sandbox does here now, why when it is not on, and the one thing that turns it on. */
export function botSandboxLines(status: BotSandboxStatus, domain: string): { value: string; detail: string; tone: "ok" | "danger" | "quiet"; command?: string } {
  if (status.state === "on") {
    const checks = status.checks;
    if (checks && checks.failed.length) return { value: t("botSandbox.on"), detail: t("botSandbox.checksFailed", { failed: checks.failed.join(", ") }), tone: "danger" };
    return { value: t("botSandbox.on"), detail: checks ? `${t("botSandbox.onDetail")} ${t("botSandbox.checks", { passed: checks.passed, total: checks.total })}` : t("botSandbox.onDetail"), tone: "ok" };
  }
  const why = status.reason === "switched-off" ? t("botSandbox.reason.switchedOff")
    : status.reason === "no-bwrap" ? t("botSandbox.reason.noBwrap")
      : status.reason === "not-linux" ? t("botSandbox.reason.notLinux")
        : t("botSandbox.reason.notPrepared");
  const command = status.reason === "userns-refused" || status.reason === "switched-off" ? sandboxInstallCommand(domain) : undefined;
  if (status.state === "refusing") return { value: t("botSandbox.refusing"), detail: `${t("botSandbox.refusingDetail")} ${why}`, tone: "danger", command };
  return { value: t("botSandbox.off"), detail: `${t("botSandbox.offDetail")} ${why}`, tone: status.reason === "switched-off" ? "quiet" : "danger", command };
}
