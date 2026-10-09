// "Get the phone app": the iPhone app on the App Store and the Android app
// as an APK. The app belongs on the phone, not on this computer, so each is a
// code to scan with the phone's camera, with the link beside it. Getting the
// app is the first step; Connect your phone, in the same menu, is the second.
import { useEffect, useRef } from "react";
import { QRCodeSVG } from "qrcode.react";

import { ANDROID_APK_URL, IOS_APP_STORE_URL, openExternalLink } from "@/lib/app-links";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";

export const PHONE_APPS: ReadonlyArray<{ id: "ios" | "android"; nameKey: LocaleKey; actionKey: LocaleKey; url: string }> = [
  { id: "ios", nameKey: "phoneApp.ios", actionKey: "phoneApp.iosAction", url: IOS_APP_STORE_URL },
  { id: "android", nameKey: "phoneApp.android", actionKey: "phoneApp.androidAction", url: ANDROID_APK_URL },
];

/** One place a phone can connect from here, as the menu offers it. */
export interface PhoneAppConnect {
  key: string;
  /** where it connects: to your Cloud (always on), to this computer… */
  subtitle: string;
  onSelect: () => void;
}

/** `connect`: where this window can pair a phone, first one first; the
 * dialog ends on that next step. Empty, it only says where the app is. */
export function PhoneAppDialog({ open, onClose, connect = [] }: { open: boolean; onClose: () => void; connect?: PhoneAppConnect[] }) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="phone-app-dialog-title"
        className="max-h-full w-full max-w-[460px] overflow-y-auto rounded-2xl border border-hairline/50 bg-panel p-6 shadow-2xl"
      >
        <h2 id="phone-app-dialog-title" className="text-[17px] font-semibold text-ink">
          {t("phoneApp.title")}
        </h2>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-secondary">{t("phoneApp.subtitle")}</p>
        <ul className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {PHONE_APPS.map((app) => (
            <li key={app.id} data-phone-app={app.id} className="flex flex-col items-center gap-3 rounded-xl bg-card p-4 text-center">
              <div className="text-[14px] font-medium text-ink">{t(app.nameKey)}</div>
              <div className="rounded-md bg-white p-2">
                <QRCodeSVG value={app.url} size={132} level="M" bgColor="#ffffff" fgColor="#111111" title={t(app.actionKey)} />
              </div>
              <button type="button" onClick={() => void openExternalLink(app.url)} className="text-[13px] text-accent hover:underline">
                {t(app.actionKey)}
              </button>
            </li>
          ))}
        </ul>
        {connect.length ? (
          <div className="mt-4 flex flex-col gap-2">
            <p className="text-[13px] leading-relaxed text-ink-secondary">{t("phoneApp.next")}</p>
            {connect.map((destination, index) => (
              <button
                key={destination.key}
                type="button"
                data-phone-app-connect={destination.key}
                onClick={() => {
                  onClose();
                  destination.onSelect();
                }}
                className={index === 0
                  ? "flex w-full flex-col items-center rounded-xl bg-accent px-4 py-2 text-[13px] font-medium text-accent-ink hover:opacity-90"
                  : "flex w-full flex-col items-center rounded-xl border border-hairline/50 px-4 py-2 text-[13px] font-medium text-ink hover:bg-raised"}
              >
                <span>{t("sidebar.menu.connectPhone")}</span>
                <span className="text-[12px] font-normal opacity-80">{destination.subtitle}</span>
              </button>
            ))}
          </div>
        ) : null}
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          className="mt-3 w-full rounded-xl bg-raised px-4 py-2 text-[13px] font-medium text-ink hover:brightness-110"
        >
          {t("common.close")}
        </button>
      </div>
    </div>
  );
}
