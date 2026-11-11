import { ANDROID_APK_URL, IOS_APP_STORE_URL, openExternalLink } from "@/lib/app-links";
import { productName } from "@/lib/brand";
import { t } from "@/lib/i18n";

export const PHONE_APPS = [
  { id: "ios", label: "App Store", url: IOS_APP_STORE_URL },
  { id: "android", label: "Android", url: ANDROID_APK_URL },
] as const;

export function PhoneAppLinks({ className }: { className?: string }) {
  return (
    <div data-phone-app-links="" className={className}>
      <p>{t("phoneApp.install", { app: productName() })}</p>
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

/** The same line inside a row's description, with the two stores as links in the sentence itself. */
export function StoreLinks() {
  const marks = { appStore: "⁣a⁣", android: "⁣b⁣" };
  const line = t("phone.pair.installLine", { app: productName(), ...marks });
  return <>{line.split(/(⁣[ab]⁣)/).map((part) => {
    const app = part === marks.appStore ? PHONE_APPS[0] : part === marks.android ? PHONE_APPS[1] : null;
    return app
      ? <a key={app.id} href={app.url} data-phone-app={app.id} target="_blank" rel="noreferrer" onClick={(event) => { event.preventDefault(); void openExternalLink(app.url); }}
        className="whitespace-nowrap text-accent-text hover:underline focus-visible:underline">{app.label}</a>
      : part;
  })}</>;
}
