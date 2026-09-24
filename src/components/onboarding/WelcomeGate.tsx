// Decides what first run looks like for whoever opened the app. The desktop
// app's own window is the owner of its own server and gets the welcome flow
// exactly as before, without waiting on anything new. Any other page (a
// browser, or a hosted workspace the desktop app opened with its reduced
// bridge) asks its server who it is first. A hosted workspace's admin gets
// the hosted beats and a hosted member a quiet note. A session that cannot
// save the workspace config is never shown a tour it could not finish.
import { useEffect, useState } from "react";
import { emailGateDone } from "@/lib/analytics";
import { hostedMember, LOCAL_VIEWER, welcomeDue, welcomeViewer, type BeatId, type WelcomeViewer } from "@/lib/onboarding";
import { api, useStore } from "@/state/store";
import { SharedWorkspaceHint } from "./SharedWorkspaceHint";
import { WelcomeFlow } from "./WelcomeFlow";

/** Only the desktop app's own pages get the full bridge; `remoteClient` is
 * part of it. A remote page the desktop app loads (Server → Connect hosted
 * workspace…) gets a reduced, still truthy `window.ogb` without it, and is
 * no more the owner than a browser is. */
export function localDesktopPage(): boolean {
  return window.ogb?.remoteClient !== undefined;
}

/** Null while the answer is on its way. The desktop app's own page knows at
 * once: its own server's owner, or a remote client, which never gets a
 * first-run surface anyway. A failed answer keeps the old behaviour. */
export function useWelcomeViewer(): WelcomeViewer | null {
  const local = localDesktopPage();
  const [viewer, setViewer] = useState<WelcomeViewer | null>(local ? LOCAL_VIEWER : null);
  useEffect(() => {
    if (local) return;
    let active = true;
    void api("/api/auth/session", { timeoutMs: 10_000 })
      .then((session) => {
        if (active) setViewer(welcomeViewer(session));
      })
      .catch(() => {
        if (active) setViewer(LOCAL_VIEWER);
      });
    return () => {
      active = false;
    };
  }, [local]);
  return viewer;
}

/** Opens the welcome flow on a fresh workspace (the server's onboarding
 * record says so) or on request from Settings. The decision waits for the
 * config to arrive, so a returning user never sees the tour flash. */
export function WelcomeGate({ viewer }: { viewer: WelcomeViewer | null }) {
  const { state, dispatch } = useStore();
  const [dismissed, setDismissed] = useState(false);
  // Set when the engines beat's organisation row opened Settings, so closing
  // Settings brings the person back to that beat rather than the greeting.
  const [resumeAt, setResumeAt] = useState<BeatId | undefined>(undefined);
  const remoteClient = window.ogb?.remoteClient?.active === true;
  if (!viewer) return null;
  // Only a hosted workspace is a team's by definition. Elsewhere a session
  // without admin scope is often the owner's own phone or browser, so it
  // gets no new note: the tour it cannot save simply does not open itself.
  if (hostedMember(viewer)) {
    return remoteClient ? null : (
      <SharedWorkspaceHint
        replay={state.welcomeOpen}
        onClose={() => {
          if (state.welcomeOpen) dispatch({ type: "toggleWelcome", open: false });
        }}
      />
    );
  }
  const due =
    !dismissed &&
    welcomeDue(state.config, {
      remoteClient,
      legacyDone: emailGateDone(),
      hosted: viewer.hosted,
      canSave: viewer.canSave,
    });
  // Explicit desktop connection Settings need no local provider onboarding.
  // Organisation remains optional; closing Settings resumes the normal tour.
  if (state.appSettingsOpen && ["desktopWorkspaces", "organization"].includes(state.appSettingsSection)) return null;
  if (!state.welcomeOpen && !due) return null;
  const bot = state.bots.find((b) => !b.hidden) ?? null;
  const replay = state.welcomeOpen && !due;
  return (
    <WelcomeFlow
      bot={bot}
      replay={replay}
      hosted={viewer.hosted}
      initialBeat={resumeAt}
      onOpenOrganisation={() => {
        setResumeAt("engines");
        dispatch({ type: "toggleAppSettings", open: true, section: "organization" });
      }}
      onDone={() => {
        setDismissed(true);
        setResumeAt(undefined);
        dispatch({ type: "toggleWelcome", open: false });
        // the first real finish hands over to the guided tour; a replay does not
        if (!replay) dispatch({ type: "toggleTour", open: true });
      }}
    />
  );
}
