import { useState } from "react";
import { Trash2 } from "lucide-react";

import { t } from "@/lib/i18n";
import { api, useStore } from "@/state/store";
import { phoneAppChips, phonePlatformLabel, phoneRemovePath, usePhones } from "../lib/phones";
import { relative } from "./CompanionSection";

export function PhonesList() {
  const { phase, phones, refresh } = usePhones();
  const { dispatch } = useStore();
  const [removing, setRemoving] = useState<string | null>(null);
  if (phase === "loading") return null;

  const remove = (key: string) => {
    if (removing) return;
    setRemoving(key);
    void api(phoneRemovePath(key), { method: "DELETE" })
      .catch((error: unknown) => dispatch({ type: "error", message: error instanceof Error ? error.message : String(error) }))
      .finally(() => {
        setRemoving(null);
        refresh();
      });
  };

  return (
    <div className="border-t border-hairline/30 pt-4">
      <div className="text-[13px] text-ink">{t("remote.phones.title")}</div>
      {phones.length === 0 ? (
        <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">{t("remote.phones.empty")}</div>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {phones.map((phone) => {
            const { name, platform } = phone.registration;
            return (
              <li key={phone.key} className="rounded-xl bg-inset px-3 py-3">
                <div className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[14px] font-medium text-ink">
                      {name} <span className="font-normal text-ink-secondary">· {phonePlatformLabel(platform)}</span>
                    </div>
                    <div className="text-[12px] text-ink-secondary">
                      {phone.online ? t("remote.phones.online") : t("remote.phones.offline", { when: relative(phone.seen) })}
                    </div>
                  </div>
                  <button
                    disabled={removing !== null}
                    onClick={() => remove(phone.key)}
                    aria-label={t("remote.phones.remove", { name })}
                    className="shrink-0 rounded p-1.5 text-ink-secondary hover:bg-control hover:text-danger disabled:opacity-40"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {phoneAppChips(phone).map((cap) => (
                    <span key={cap} className="rounded-full bg-control px-2 py-0.5 text-[11px] text-ink-secondary">
                      {t(`botAccess.phone.cap.${cap}`)}
                    </span>
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
