import { GOOGLE_PLAY_URL, IOS_APP_STORE_URL, openExternalLink } from "@/lib/app-links";
import { productName } from "@/lib/brand";
import { t } from "@/lib/i18n";

export const PHONE_APPS = [
  { id: "ios", label: "App Store", url: IOS_APP_STORE_URL },
  { id: "android", label: "Google Play", url: GOOGLE_PLAY_URL },
] as const;

export function PhoneAppLinks({ className }: { className?: string }) {
  return (
    <div data-phone-app-links="" className={className}>
      <p>{t("phoneApp.installStores", { app: productName() })}</p>
      <div className="mt-1.5 flex gap-4">
        {PHONE_APPS.map((app) => (
          <button key={app.id} type="button" data-phone-app={app.id} onClick={() => void openExternalLink(app.url)} className="text-accent hover:underline">
            {app.label}
          </button>
        ))}
      </div>
    </div>
  );
}
