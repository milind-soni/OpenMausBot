import { openExternalLink } from "@/lib/app-links";
import { t } from "@/lib/i18n";

const OPEN_BOT_AVATAR = "https://github.com/DominikScholz/open-bot-avatar";

/** Credit for the avatar shapes and engine we use from Open Bot Avatar (MIT). */
export function AvatarCredit() {
  return (
    <a
      href={OPEN_BOT_AVATAR}
      onClick={(event) => {
        event.preventDefault();
        void openExternalLink(OPEN_BOT_AVATAR);
      }}
      data-avatar-credit
      className="mx-auto mt-2 block w-fit text-center text-[11px] text-ink-tertiary hover:text-ink-secondary hover:underline"
    >
      {t("mascot.avatarCredit")}
    </a>
  );
}
