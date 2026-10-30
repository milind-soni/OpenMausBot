import { useEffect, useId, useRef, useState } from "react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { t } from "@/lib/i18n";
import { saveTeamProfile } from "@/lib/own-profile";
import { IMAGE_MAX_BYTES, imageAttachmentFromFile, isImageFile } from "@/lib/composer-attachments";
import type { LocaleKey } from "@/locales";
import { botAvatarUrlFromStoredPath } from "../../shared/bot-avatar";
import { AboutMeSettings } from "./AboutMeSettings";
import { profileInitials } from "./SidebarProfileMenu";
import { User } from "lucide-react";

const PHOTO_MIN_SIDE = 64;
const PHOTO_MAX_SIDE = 8192;
/** What is stored is always this square WebP, drawn fresh: the original's metadata (location, camera) never leaves the picker. */
const PHOTO_STORED_SIDE = 512;

type PhotoDraft = { file: File; previewUrl: string; width: number; height: number; zoom: number };

/** Checked before the picture is even decoded; null when the file may become a draft. */
export function profilePhotoFileProblem(file: { type: string; size: number }): LocaleKey | null {
  if (!isImageFile(file)) return "settings.profile.avatar.invalidType";
  if (file.size > IMAGE_MAX_BYTES) return "settings.profile.avatar.tooLarge";
  return null;
}

export function profilePhotoSizeProblem(width: number, height: number): LocaleKey | null {
  if (width < PHOTO_MIN_SIDE || height < PHOTO_MIN_SIDE) return "settings.profile.avatar.tooSmall";
  if (width > PHOTO_MAX_SIDE || height > PHOTO_MAX_SIDE) return "settings.profile.avatar.tooLargeDimensions";
  return null;
}

async function withImage<T>(file: File, use: (image: HTMLImageElement) => T | Promise<T>): Promise<T> {
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("invalid-image"));
      element.src = url;
    });
    if (image.naturalWidth <= 0 || image.naturalHeight <= 0) throw new Error("invalid-image");
    return await use(image);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** The centred square the zoom slider previews. */
function croppedPhoto(file: File, zoom: number): Promise<File> {
  return withImage(file, async (image) => {
    const side = Math.min(image.naturalWidth, image.naturalHeight) / Math.max(1, zoom);
    const canvas = document.createElement("canvas");
    canvas.width = PHOTO_STORED_SIDE;
    canvas.height = PHOTO_STORED_SIDE;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("canvas-unavailable");
    context.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, PHOTO_STORED_SIDE, PHOTO_STORED_SIDE);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("image-encode-failed")), "image/webp", 0.9));
    return new File([blob], "profile-photo.webp", { type: "image/webp" });
  });
}

/** The person's own picture beside their name in the sidebar. Kept in the app's attachment store; "" removes it. */
function ProfilePhoto() {
  const { state, dispatch } = useStore();
  const avatarUrl = state.config?.profile?.avatarUrl ?? "";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<PhotoDraft | null>(null);
  const draftRef = useRef<PhotoDraft | null>(null);
  const replaceDraft = (next: PhotoDraft | null) => {
    const previous = draftRef.current;
    if (previous && previous.previewUrl !== next?.previewUrl) URL.revokeObjectURL(previous.previewUrl);
    draftRef.current = next;
    setDraft(next);
  };
  useEffect(() => () => {
    if (draftRef.current) URL.revokeObjectURL(draftRef.current.previewUrl);
  }, []);
  const team = Boolean(state.config?.team);
  const store = async (next: string) => {
    const profile = team
      ? await saveTeamProfile({ avatarUrl: next })
      : (await api<ConfigStatus>("/api/config", { method: "PUT", body: JSON.stringify({ profile: { avatarUrl: next } }) })).profile;
    dispatch({ type: "profileSaved", profile: { avatarUrl: profile?.avatarUrl } });
  };
  const pick = (file: File | undefined) => {
    if (!file) return;
    setError(null);
    const fileProblem = profilePhotoFileProblem(file);
    if (fileProblem) return setError(t(fileProblem));
    void withImage(file, (image) => ({ width: image.naturalWidth, height: image.naturalHeight })).then(({ width, height }) => {
      const sizeProblem = profilePhotoSizeProblem(width, height);
      if (sizeProblem) return setError(t(sizeProblem));
      replaceDraft({ file, previewUrl: URL.createObjectURL(file), width, height, zoom: 1 });
    }, () => setError(t("settings.profile.avatar.invalidType")));
  };
  const save = (current: PhotoDraft) => {
    setBusy(true);
    setError(null);
    void croppedPhoto(current.file, current.zoom)
      .then((cropped) => imageAttachmentFromFile(cropped))
      .then((saved) => {
        const next = saved ? botAvatarUrlFromStoredPath(saved.path) : null;
        if (!next) throw new Error("avatar");
        return store(next);
      })
      .then(() => replaceDraft(null), () => setError(t("settings.profile.avatar.saveError")))
      .finally(() => setBusy(false));
  };
  const remove = () => {
    setError(null);
    void store("").catch(() => setError(t("settings.profile.avatar.saveError")));
  };

  return (
    <>
      <div className="flex items-center gap-3">
        {draft ? (
          <div className="flex w-full flex-col gap-2 rounded-lg border border-hairline/40 bg-inset p-2">
            <div className="flex items-center gap-3">
              <div className="size-16 shrink-0 overflow-hidden rounded-full bg-raised">
                <img src={draft.previewUrl} alt="" className="size-full object-cover" style={{ transform: `scale(${draft.zoom})` }} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[12px] font-medium text-ink">{t("settings.profile.avatar.cropTitle")}</div>
                <div className="text-[11px] text-ink-secondary">{draft.width} × {draft.height}px</div>
                <label className="mt-1 block text-[11px] text-ink-secondary">{t("settings.profile.avatar.zoom")}
                  <input aria-label={t("settings.profile.avatar.zoom")} type="range" min="1" max="2.5" step="0.05" value={draft.zoom} onChange={(event) => replaceDraft({ ...draft, zoom: Number(event.target.value) })} className="ml-2 w-28 align-middle accent-accent" />
                </label>
              </div>
              <button type="button" className="rounded-md px-2 py-1 text-[12px] text-ink-secondary hover:bg-control" onClick={() => replaceDraft(null)}>{t("settings.profile.avatar.cancel")}</button>
              <button type="button" className="rounded-md bg-control px-2 py-1 text-[12px] text-ink hover:bg-raised-hover" disabled={busy} onClick={() => save(draft)}>{t("settings.profile.avatar.save")}</button>
            </div>
          </div>
        ) : avatarUrl ? <img src={avatarUrl} alt="" className="size-12 rounded-full object-cover" /> : <div className="size-12 rounded-full bg-raised" />}
        <label className="cursor-pointer rounded-lg bg-control px-3 py-2 text-[12px] text-ink hover:bg-raised-hover">
          {busy ? t("settings.profile.avatar.uploading") : t("settings.profile.avatar.choose")}
          <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" className="sr-only" disabled={busy} onChange={(event) => {
            const file = event.target.files?.[0];
            event.currentTarget.value = "";
            pick(file);
          }} />
        </label>
        {avatarUrl && !draft && <button type="button" className="text-[12px] text-ink-secondary underline" onClick={remove}>{t("settings.profile.avatar.remove")}</button>}
      </div>
      {error && <div role="alert" className="text-[12px] text-danger">{error}</div>}
    </>
  );
}

export function ProfileFields() {
  const { state, dispatch } = useStore();
  const [name, setName] = useState(state.config?.profile?.name ?? "");
  const [email, setEmail] = useState(state.config?.profile?.email ?? "");
  useEffect(() => {
    setName(state.config?.profile?.name ?? "");
    setEmail(state.config?.profile?.email ?? "");
  }, [state.config?.profile?.name, state.config?.profile?.email]);

  const team = Boolean(state.config?.team);
  const save = () => {
    if (team) {
      void saveTeamProfile({ name: name.trim() })
        .then((profile) => dispatch({ type: "profileSaved", profile: { name: profile.name, email: profile.email } }))
        .catch(() => {});
      return;
    }
    void fetch("/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile: { name: name.trim(), email: email.trim().toLowerCase() } }),
    })
      .then((r) => { if (!r.ok) throw new Error("Profile save failed"); return r.json(); })
      .then((config: ConfigStatus) => {
        if (config.profile) dispatch({ type: "profileSaved", profile: { name: config.profile.name, email: config.profile.email } });
      })
      .catch(() => {});
  };

  const inputClass =
    "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none";
  return (
    <div className="flex flex-col gap-3">
      <ProfilePhoto />
      <input aria-label={t("settings.profile.name")} value={name} onChange={(e) => setName(e.target.value)} onBlur={save} placeholder={t("settings.profile.name")} className={inputClass} />
      <input
        type="email"
        aria-label={t("phone.signIn.email")}
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        onBlur={team ? undefined : save}
        readOnly={team}
        placeholder="you@example.com"
        className={inputClass}
      />
      <AboutMeSettings />
    </div>
  );
}

function ProfileAvatar({ profile }: { profile?: { name?: string; email?: string; avatarUrl?: string } }) {
  const [failed, setFailed] = useState<string | null>(null);
  const initials = profileInitials(profile);
  const photo = profile?.avatarUrl && failed !== profile.avatarUrl ? profile.avatarUrl : null;
  return (
    <span className="flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-full bg-ink/[0.06] text-[15px] font-medium text-ink-secondary">
      {photo ? <img src={photo} alt="" onError={() => setFailed(photo)} className="size-full object-cover" />
        : initials !== "?" ? initials : <User size={20} aria-hidden="true" />}
    </span>
  );
}

export function ProfileSummaryRow() {
  const { state } = useStore();
  const [editing, setEditing] = useState(false);
  const profile = state.config?.profile;
  const name = profile?.name?.trim() ?? "";
  const email = profile?.email?.trim() ?? "";
  const fieldsId = useId();
  const fields = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (editing) fields.current?.querySelector<HTMLInputElement>("input:not([type=file])")?.focus();
  }, [editing]);
  return (
    <div data-profile-summary="" className="px-4 py-[13px]">
      <div className="flex min-w-0 items-center gap-3">
        <ProfileAvatar profile={profile} />
        <div className="min-w-0 flex-1">
          {name || email ? <>
            <div className="truncate text-[14px] leading-5 text-ink">{name || email}</div>
            {name && email && <div className="truncate text-[13px] leading-[18px] text-ink-secondary">{email}</div>}
          </> : <div className="truncate text-[14px] leading-5 text-ink-secondary">{t("settings.simple.account.noName")}</div>}
        </div>
        <button type="button" aria-expanded={editing} aria-controls={fieldsId} className="ui-button shrink-0" onClick={() => setEditing(!editing)}>
          {editing ? t("common.done") : t(name || email ? "settings.simple.account.edit" : "settings.simple.account.add")}
        </button>
      </div>
      <div id={fieldsId} ref={fields} hidden={!editing} className="mt-4">
        {editing && <ProfileFields />}
      </div>
    </div>
  );
}
