import { useState } from "react";
import { Trash2 } from "lucide-react";

import { t } from "@/lib/i18n";
import { api, useStore } from "@/state/store";
import { phoneAppChips, phonePlatformLabel, phoneRemovePath, usePhones } from "../lib/phones";
import { relative } from "./PhoneDevicesSection";

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

  if (phones.length === 0) return null;
  return (
    <section className="flex flex-col gap-2" data-settings-block="phone-apps">
      <h3 className="px-4 text-[13px] font-medium leading-[18px] text-ink">{t("remote.phones.title")}</h3>
      {(
        <ul data-settings-rows="" className="flex flex-col overflow-hidden rounded-[12px] border-[0.5px] border-(--settings-edge) bg-menu">
          {phones.map((phone) => {
            const { name, platform } = phone.registration;
            return (
              <li key={phone.key} className="px-4 py-3">
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
    </section>
  );
}
