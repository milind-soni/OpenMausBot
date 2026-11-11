import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { ANDROID_APK_URL, IOS_APP_STORE_URL, openExternalLink } from "@/lib/app-links";
import { productName } from "@/lib/brand";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";

export const PHONE_APPS: ReadonlyArray<{ id: "ios" | "android"; nameKey: LocaleKey; actionKey: LocaleKey; url: string }> = [
  { id: "ios", nameKey: "phoneApp.ios", actionKey: "phoneApp.iosAction", url: IOS_APP_STORE_URL },
  { id: "android", nameKey: "phoneApp.android", actionKey: "phoneApp.androidAction", url: ANDROID_APK_URL },
];

/** "On your phone, install MausBot from the App Store, or download it for Android": the two stores as plain links that
 * open in the browser. The pairing code is the only code to scan anywhere, so nothing here looks scannable. */
export function StoreLinks({ text }: { text?: (links: { appStore: string; android: string }) => string }) {
  const marks = { appStore: "\u2063a\u2063", android: "\u2063b\u2063" };
  const line = (text ?? ((links) => t("phone.pair.installLine", { app: productName(), ...links })))(marks);
  const link = (id: "ios" | "android", label: string): ReactNode => {
    const app = PHONE_APPS.find((entry) => entry.id === id)!;
    return <a key={id} href={app.url} data-phone-app={id} target="_blank" rel="noreferrer"
      onClick={(event) => { event.preventDefault(); void openExternalLink(app.url); }}
      className="text-accent-text hover:underline focus-visible:underline">{label}</a>;
  };
  return <>{line.split(/(\u2063[ab]\u2063)/).map((part) => part === marks.appStore ? link("ios", t("phone.pair.appStore"))
    : part === marks.android ? link("android", t("phone.pair.android")) : part)}</>;
}

export interface PhoneAppConnect {
  key: string;
  subtitle: string;
  onSelect: () => void;
}

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

  const overlay = (
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
        <p className="mt-4 text-[13px] leading-[18px] text-ink" data-store-links=""><StoreLinks /></p>
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

  return typeof document === "undefined" ? overlay : createPortal(overlay, document.body);
}
