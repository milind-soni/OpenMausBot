import { useEffect, useRef } from "react";

import {
  APP_NAME,
  APP_REPOSITORY,
  DOCS_URL,
  LICENSE_URL,
  RELEASES_URL,
  appVersion,
  openExternalLink,
  platformLabel,
} from "@/lib/app-links";
import { productName } from "@/lib/brand";
import { t } from "@/lib/i18n";
import { useOtherServerName } from "@/lib/other-server";

/** The app's own version first; `server` (useOtherServerName: set only when the app's window shows another server) adds a
 * line naming it with the version its page runs. A browser, or an app too old to say, keeps the page's version on one line. */
export function aboutVersionLines({ app, bundle, platform, server }: {
  app?: { version: string } | null;
  bundle: string;
  platform: string | null;
  server: string | null;
}): string[] {
  const line = (version: string) => `${t("about.version", { version })}${platform ? ` · ${platform}` : ""}`;
  if (!app?.version) return [line(bundle)];
  return server ? [line(app.version), t("about.connectedTo", { name: server, version: bundle })] : [line(app.version)];
}

export function AboutDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const server = useOtherServerName(open);

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

  const [version, connected] = aboutVersionLines({ app: window.ogb?.app, bundle: appVersion(), platform: platformLabel(window.ogb?.platform), server });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="about-dialog-title"
        className="w-full max-w-[360px] rounded-2xl border border-hairline/50 bg-panel p-6 text-center shadow-2xl"
      >
        <img src="/app-icon.svg" alt="" width={56} height={56} className="mx-auto size-14" />
        <h2 id="about-dialog-title" className="mt-3 text-[17px] font-semibold text-ink">
          {productName()}
        </h2>
        <p className="mt-1 text-[13px] text-ink-secondary">{version}</p>
        {connected && <p className="mt-0.5 text-[13px] text-ink-secondary">{connected}</p>}
        <p className="mt-3 text-[13px] leading-relaxed text-ink-secondary">
          A desktop home for your agents, built on {APP_NAME}: open source, Apache 2.0 licensed.
        </p>
        <div className="mt-4 flex flex-wrap justify-center gap-x-4 gap-y-1.5 text-[13px]">
          <AboutLink href={APP_REPOSITORY} label="GitHub" />
          <AboutLink href={DOCS_URL} label="Docs" />
          <AboutLink href={RELEASES_URL} label="Releases" />
          <AboutLink href={LICENSE_URL} label="License" />
        </div>
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          className="mt-5 w-full rounded-xl bg-raised px-4 py-2 text-[13px] font-medium text-ink hover:brightness-110"
        >
          Close
        </button>
      </div>
    </div>
  );
}

function AboutLink({ href, label }: { href: string; label: string }) {
  return (
    <button
      type="button"
      onClick={() => void openExternalLink(href)}
      className="text-accent hover:underline"
    >
      {label}
    </button>
  );
}
