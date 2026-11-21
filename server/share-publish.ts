// Sends a template folder to the MausBot Admin (openmaus-cloud server/community-submissions.ts), which opens a pull
// request on the community repository from its own GitHub App: nobody needs a GitHub account. The request is signed the
// way page publishing signs its token request: a desktop's MausBot sign-in token, or a Cloud home's machine signature
// over the label `omb-community-v1`.
import { COMMUNITY_REPOSITORY_URL } from "../shared/share-card.ts";
import { pagesAuthHeaders, type PagesAccess } from "./pages/access.ts";

export const COMMUNITY_SUBMISSIONS_PATH = "/api/cloud/community/submissions";
export const COMMUNITY_SIGNATURE_LABEL = "omb-community-v1";
/** The Admin's caps on one folder. */
export const COMMUNITY_MAX_FILES = 200, COMMUNITY_MAX_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 60_000;
const UNAVAILABLE = "Publishing isn't available right now. Try again in a few minutes.";

/** The Admin's request body: each file of the folder by its path, Markdown as text and pictures as `{ base64 }`. A resend
 * of the same slug while the account's pull request is open updates that pull request. */
export interface CommunitySubmission {
  slug: string;
  files: Record<string, string | { base64: string }>;
}

export type CommunityResult =
  | { ok: true; link: string; prUrl: string }
  /** sign_in and unavailable: publishing can't happen from here, so the card offers the folder and GitHub's upload page. */
  | { ok: false; reason: "sign_in" | "unavailable" | "failed"; message: string };

/** Security: only links into the community repository are shown as a template's link. */
function communityLink(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com" && `${url.origin}${url.pathname}`.startsWith(`${COMMUNITY_REPOSITORY_URL}/`) ? url.href : null;
  } catch {
    return null;
  }
}

const said = (body: Record<string, unknown>, fallback: string) =>
  typeof body.message === "string" && body.message.trim() ? body.message.trim().slice(0, 300)
    : typeof body.error === "string" && body.error.trim() ? body.error.trim().slice(0, 300) : fallback;

export function createCommunityPublisher(options: { access: () => PagesAccess | null; notOffered?: () => boolean; selfHosted?: boolean; fetch?: typeof fetch; now?: () => number }) {
  const http = options.fetch ?? fetch, now = options.now ?? Date.now;
  /** Why Publish can't be offered here, before trying; null when it can. */
  const availability = (): "sign_in" | "unavailable" | null => {
    if (options.access()) return null;
    return options.selfHosted || options.notOffered?.() ? "unavailable" : "sign_in";
  };
  return {
    availability,
    async submit(submission: CommunitySubmission): Promise<CommunityResult> {
      const access = options.access();
      if (!access) {
        const reason = availability() ?? "unavailable";
        return { ok: false, reason, message: reason === "sign_in" ? "Sign in to MausBot to publish." : "Publishing isn't available here." };
      }
      const body = JSON.stringify(submission);
      let response: Response;
      try {
        response = await http(`${new URL(access.url).origin}${COMMUNITY_SUBMISSIONS_PATH}`, {
          method: "POST", redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS), body,
          headers: { "content-type": "application/json", accept: "application/json", ...pagesAuthHeaders(access, body, now(), COMMUNITY_SIGNATURE_LABEL) },
        });
      } catch {
        return { ok: false, reason: "failed", message: UNAVAILABLE };
      }
      let answer: Record<string, unknown> = {};
      try {
        const parsed = await response.json();
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) answer = parsed as Record<string, unknown>;
      } catch {
        answer = {};
      }
      if (response.status === 401) {
        return access.kind === "desktop"
          ? { ok: false, reason: "sign_in", message: "Your MausBot sign-in has ended. Sign in again to publish." }
          : { ok: false, reason: "failed", message: UNAVAILABLE };
      }
      if (response.status === 404 || response.status === 501) return { ok: false, reason: "unavailable", message: "Publishing isn't available here." };
      if (response.status === 429) return { ok: false, reason: "failed", message: said(answer, "You've published a lot today. Try again tomorrow.") };
      if (!response.ok) return { ok: false, reason: "failed", message: response.status < 500 || response.status === 503 ? said(answer, UNAVAILABLE) : UNAVAILABLE };
      const link = communityLink(answer.link), prUrl = communityLink(answer.prUrl);
      return link && prUrl ? { ok: true, link, prUrl } : { ok: false, reason: "failed", message: UNAVAILABLE };
    },
  };
}
export type CommunityPublisher = ReturnType<typeof createCommunityPublisher>;
