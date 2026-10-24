import { ArrowUp } from "lucide-react";
import { t } from "@/lib/i18n";

export function ComposerSendControls({ busy, pending, retrySteer, sendLabel, onSend }: {
  busy: boolean;
  pending: boolean;
  retrySteer?: boolean;
  sendLabel: string;
  onSend(): void;
}) {
  const label = t(retrySteer ? "composer.delivery.retrySteer" : busy ? "composer.delivery.queue" : "composer.send.message");
  return <button type="button" onClick={onSend} disabled={pending} aria-label={label}
    title={`${t("chat.send")} (${sendLabel})`}
    className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent text-white hover:brightness-110 disabled:opacity-50">
    <ArrowUp size={17} aria-hidden="true" />
  </button>;
}
