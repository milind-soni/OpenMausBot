import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

import { t } from "@/lib/i18n";

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
          {t("sidebar.menu.connectPhone")}
        </h2>
        {connect.length ? (
          <div className="mt-4 flex flex-col gap-2">
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
