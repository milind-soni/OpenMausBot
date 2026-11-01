import { LockKeyhole } from "lucide-react";
import type { FormEvent } from "react";
import { t } from "@/lib/i18n";


/**
 * A site's HTTP sign-in (basic or digest), which a page cannot draw itself. Security: the password goes only to that
 * site's challenge; the fields are uncontrolled and cleared once sent, so it is never kept in state.
 */
export function AuthPrompt({ origin, realm, onAnswer }: {
  origin: string;
  realm: string;
  onAnswer: (answer: { username: string; password: string } | null) => void;
}) {
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const username = form.elements.namedItem("username") as HTMLInputElement;
    const password = form.elements.namedItem("password") as HTMLInputElement;
    onAnswer({ username: username.value, password: password.value });
    username.value = "";
    password.value = "";
  };
  return (
    <form role="dialog" aria-label={t("ui.authPrompt.signInToThisSite")} onSubmit={submit} className="absolute inset-x-3 top-3 z-20 mx-auto flex max-w-sm flex-col gap-2.5 rounded-xl border border-hairline/60 bg-card p-4 text-ink shadow-xl">
      <div className="flex items-center gap-2 text-[13px] font-medium"><LockKeyhole size={14} aria-hidden="true" />{t("chat.notice.signIn")}</div>
      <p className="break-words text-[12px] text-ink-secondary">{origin}{realm ? t("ui.authPrompt.asksForRealm", { realm }) : ""}</p>
      <input name="username" aria-label={t("ui.authPrompt.username")} autoComplete="off" spellCheck={false} maxLength={1024} placeholder={t("ui.authPrompt.username")} className="rounded-lg bg-inset px-3 py-2 text-[13px] outline-none focus:ring-1 focus:ring-accent" />
      <input name="password" type="password" aria-label={t("logins.password")} autoComplete="new-password" maxLength={1024} placeholder={t("logins.password")} className="rounded-lg bg-inset px-3 py-2 text-[13px] outline-none focus:ring-1 focus:ring-accent" />
      <div className="flex justify-end gap-2">
        <button type="button" onClick={() => onAnswer(null)} className="rounded-lg px-3 py-1.5 text-[12px] text-ink-secondary hover:bg-inset">{t("connectedWorkspaces.cancel")}</button>
        <button type="submit" className="rounded-lg bg-accent px-3 py-1.5 text-[12px] text-accent-ink">{t("chat.notice.signIn")}</button>
      </div>
    </form>
  );
}
