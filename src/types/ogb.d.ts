// The narrow bridge the Electron preload exposes. Absent in the browser.

declare global {
  type CompanyBackupEntry = Omit<import("../../electron/company-backups.mjs").CompanyBackupMetadata, "status"> & { status: "creating" | "uploading" | "completing" | "ready" | "cleanup" };
  interface CompanyBackupScheduleState {
    enabled: boolean;
    status: "off" | "waiting" | "running" | "paused" | "error";
    nextBackupAt?: number;
    lastAttemptAt?: number;
    lastBackupAt?: number;
    message?: string;
  }
  interface CompanyBackupState {
    busy: boolean;
    pendingRestore?: boolean;
    kind?: "backup" | "restore";
    progress?: import("../../electron/company-backups.mjs").CompanyBackupProgress;
    message?: string;
    lastBackupAt?: number;
    schedule?: CompanyBackupScheduleState;
  }
/** The package.json version, inlined by Vite's define at build time. */
const __APP_VERSION__: string;

  type DesktopSharedFolder = import("../../electron/computer-sharing.mjs").SharedFolder;
  type DesktopComputerSharing = import("../../electron/computer-sharing.mjs").SharingState;
  type DesktopLendingActivity = import("../../electron/computer-sharing.mjs").LendingActivityEntry;

  type DesktopCapabilities = {
    host: {
      platform: "darwin" | "linux" | "win32" | "other";
      /** The user's home folder, for showing paths as ~/… */
      homeDir?: string;
      label: string;
      session: "x11" | "wayland" | "headless" | "unknown";
      packaged: boolean;
    };
    windowChrome: "mac-inset" | "win-caption" | "native";
    screenPreview: {
      available: boolean;
      interaction: "direct" | "portal-picker" | "none";
      reasonCode?: string;
    };
    dictation: {
      available: boolean;
      engine: "apple-speech" | "none";
      onDevice: boolean;
      reasonCode?: string;
    };
    localComputer: {
      available: boolean;
      support: "supported" | "limited" | "unsupported";
      enabled: boolean;
      status: "disabled" | "checking" | "starting" | "ready" | "error" | "stopped" | "unavailable";
      reasonCode?: string;
      message?: string;
      driverPath?: string;
      driverVersion?: string;
      driverSource?: "bundled" | "environment" | "user-local" | "path";
      session?: "x11" | "wayland" | "headless" | "unknown";
      compositor?: "gnome-mutter";
    };
  };

  interface DesktopWorkspaceBounds {
    x: number;
    y: number;
    width: number;
    height: number;
  }

  interface BrowserSurfaceState {
    botId: string;
    open: boolean;
    url: string;
    title: string;
    loading: boolean;
    canGoBack: boolean;
    canGoForward?: boolean;
    visible: boolean;
    partition?: string | null;
    profile?: string | null;
    mode?: "compact" | "expanded" | null;
    code?: "renderer-gone" | "profile-deleted" | "evicted";
  }

  interface DesktopWorkspaceState {
    contextId: string;
    open: boolean;
    status: "opening" | "ready" | "error" | "closed";
    interactive: boolean;
    code?: "load-failed" | "renderer-gone";
  }

  /** Whether the desktop is holding this computer awake for routines. */
  interface DesktopRoutineWake {
    /** the toggle */
    keepAwake: boolean;
    /** a power assertion is held right now */
    hold: boolean;
    /** "due" | "running" while held; "off" | "battery" | "idle" | "stopped" otherwise */
    reason: string;
    /** the due routine's time, when the hold is for a due routine */
    at: number | null;
    onBattery: boolean;
  }
  interface DesktopRemoteClientState {
    active: boolean;
    endpoint?: string;
    serverName?: string;
    deviceId?: string;
  }

  interface Window {
    ogb?: {
      platform: NodeJS.Platform;
      /** This app's own version, and whether this page is this app's own: false on a server added in the Server menu,
       * whose page carries that server's version. Absent in desktop builds before it. */
      app?: { version: string; ownPage: boolean };
      organization?: import("../../electron/managed-desktop.mjs").ManagedDesktopBridge;
      cloudAccount?: import("../../electron/cloud-account.mjs").CloudAccountBridge;
      /** Either page in this app: the one-time move's line (on its way, what arrived, coming home). */
      cloudSendPage?: import("../../electron/cloud-send.mjs").CloudSendPageBridge;
      /** This computer's page only: bots in two places, and the one tap that brings them together on one (electron/two-places.mjs). */
      twoPlaces?: {
        state(): Promise<{ suggest: import("../lib/two-places").TwoPlacesSuggestion | null }>;
        accept(key: string): Promise<{ suggest: import("../lib/two-places").TwoPlacesSuggestion | null }>;
        dismiss(key: string): Promise<{ suggest: import("../lib/two-places").TwoPlacesSuggestion | null }>;
        onChanged(callback: () => void): () => void;
      };
      /** Settings on the person's own Cloud: the plan, read only. */
      cloudPlan?: import("../../electron/cloud-account.mjs").CloudPlanBridge;
      /** This computer's page, and My Cloud's own page once it is the person's home: the window onto My Cloud. */
      home?: import("../../electron/home-window.mjs").HomeBridge;
      desktopNotices?: import("../../electron/desktop-prefs.mjs").DesktopNoticesBridge;
      /** This computer's own page only: the account's full name, for a first run's profile (system-name.mjs). */
      desktopProfile?: { systemName(): Promise<string | null> };
      desktopAnalytics?: import("../../electron/desktop-prefs.mjs").DesktopAnalyticsBridge;
      desktopLanguage?: import("../../electron/desktop-prefs.mjs").DesktopLanguageBridge;
      /** This computer's page and My Cloud's own page: the one-time "Get MausBot updates?" answer. */
      updatesConsent?: import("../../electron/updates-consent.mjs").UpdatesConsentBridge;
      companyBackups?: {
        state(): Promise<CompanyBackupState>;
        list(): Promise<{ backups: CompanyBackupEntry[]; usedBytes: number; limits: { ownerQuotaBytes: number; retainedSnapshots: number } }>;
        create(input: { clientState: import("../../shared/workspace-backup").WorkspaceBackupClientState }): Promise<CompanyBackupEntry>;
        configureSchedule?(input: { enabled: false } | { enabled: true; confirmation: "BACK UP THIS WORKSPACE DAILY" }): Promise<CompanyBackupState>;
        prepareRestore(input: { id: string; password?: string }): Promise<{ id: string; summary: import("../../shared/workspace-backup").WorkspaceBackupSummary }>;
        restore(input: { id: string; confirmation: "REPLACE" }): Promise<{ restoreId: string }>;
        delete(input: { id: string; confirmation: "DELETE" }): Promise<unknown>;
        cancel(): Promise<void>;
        onState(callback: (state: CompanyBackupState) => void): () => void;
      };
      /** The window's own rail of places: its page at /rail (a sheet of its own covers the window while open; the skin of
       * the page beside it comes from main), and the button on the page beside it that hides and shows it. */
      rail?: import("../../electron/chrome-rail.mjs").ChromeRailBridge;
      workspaces?: {
        /** `color`: a saved server's colour name (its owner chose it while setting the Cloud up); `home`: this window's
         * home is this Cloud, so there is nothing to switch to. */
        state: () => Promise<{ local: boolean; name: string; origin?: string; color?: string; home?: boolean; role?: string }>;
        /** The native server menu; resolves when it closes. `from: "howto"`: the Show me how tip opened it. */
        menu: (options?: { from?: "howto" }) => Promise<void>;
        /** One plain line for the next page, served once: a team this person is no longer in. */
        line?: () => Promise<{ kind: "left"; name: string } | null>;
        /** The rail's circles, for this app's page and a hosted Cloud's only (empty elsewhere, and with fewer than two
         * places). Absent on an older app. */
        places?: () => Promise<import("../../electron/cloud-rail.mjs").RailState>;
        /** Opens a circle main listed, by its id, through main's own switch: only from the person's click. */
        open?: (id: string) => Promise<unknown>;
        /** ＋'s fixed choices: buy a Cloud (this computer's own sheet), a server's pairing link (`link`: the one pasted on the
         * sheet; without it, the clipboard's), or type its address. Resolves false when the person cancels Connect. */
        add?: (choice: "cloud" | "link" | "address", link?: string) => Promise<unknown>;
        /** The colour of the place this page is (This computer's too), and whether it can be changed here. Absent on an
         * older app. */
        look?: () => Promise<import("../../electron/place-look.mjs").PlaceLook | null>;
        /** That place's colour, from the person's click: one of the six swatches, or null for none. */
        color?: (swatch: import("../../electron/cloud-list.mjs").CloudSwatch | null) => Promise<{ outcome: import("../../electron/place-look.mjs").PlaceColorOutcome; look: import("../../electron/place-look.mjs").PlaceLook | null }>;
        /** The colour of a place the window's rail lists, by its circle's id, from the person's click on the rail's own
         * page (refused on any other page). */
        recolor?: (id: string, swatch: import("../../electron/cloud-list.mjs").CloudSwatch | null) => Promise<{ outcome: import("../../electron/place-look.mjs").PlaceColorOutcome; look: import("../../electron/place-look.mjs").PlaceLook | null }>;
        /** Remove from list: a Cloud the window's rail lists as `removable`, by its circle's id, once the person said yes on
         * the rail's own page (refused on any other page). Absent on an older app. */
        remove?: (id: string) => Promise<{ outcome: import("../../electron/cloud-account.mjs").CloudRemoveOutcome }>;
        /** Make a server of the person's own, which the rail lists with `makeHome`, their bots' home: the move starts. */
        makeHome?: (id: string) => Promise<{ started: true }>;
        /** Main's word that the places or the sign-in changed: read them again. */
        onChanged?: (callback: () => void) => () => void;
      };
      /** Buying another Cloud from the rail's ＋, on this app's page or a hosted Cloud's; absent on an older app. */
      cloudAdd?: {
        state(): Promise<import("../../electron/cloud-rail.mjs").AddCloudView>;
        /** Opens that plan's checkout in the browser, for a Cloud of this name and swatch; only from the person's click. */
        /** `source`: where the checkout started, one of the app's checkout sources (main ignores any other). */
        start(tier: string, name: string, color: import("../../electron/cloud-list.mjs").CloudSwatch | null, source?: string): Promise<{ outcome: "opened" | "unsupported" | "failed" } | { outcome: "blocked"; blocked: import("../../electron/cloud-account.mjs").CloudAddBlock }>;
        reopen(): Promise<boolean>;
        copyLink(): Promise<boolean>;
        /** Opens the Cloud just bought, once it is ready. */
        open(): Promise<void>;
        interest(): Promise<void>;
        /** The sheet is open on this page (main then says "ready" here, not with a notification). */
        sheet(open: boolean): Promise<void>;
        /** A new organization on the Team plan this account pays for, of this name and swatch: no checkout; only from the person's click. */
        organization?(name: string, color: import("../../electron/cloud-list.mjs").CloudSwatch | null): Promise<{ outcome: "added" | "taken" | "unsupported" | "failed" }
          | { outcome: "blocked"; blocked: import("../../electron/cloud-list.mjs").OrganizationBlock }>;
      };
      /** Saved servers and the active one (desktop Server menu). Present on
       * the local server's UI; a remote server's page sees a reduced bridge. */
      environments?: {
        state: () => Promise<{
          localOrigin: string;
          remote: boolean;
          /** Named local environments exist only in a packaged build. */
          packaged: boolean;
          activeId: string;
          environments: Array<{
            id: string;
            kind?: "local" | "remote";
            name: string;
            origin?: string;
            dataDir?: string;
            missing?: boolean;
            /** One of the six Cloud colours (environments.cjs ENTRY_COLORS). */
            color?: string;
            /** The person's own My Cloud. */
            home?: boolean;
            /** Another Cloud of the person's own, as the verified session lists it. */
            cloud?: { id: string; role: string };
          }>;
        }>;
        /** Local targets answer {ok, error?} (error strings are an open set); remote ones answer nothing. */
        switch: (id: string) => Promise<{ ok: boolean; error?: string } | void>;
        addFromLink: (link: string, name?: string) => Promise<boolean | void>;
        /** Register a named local environment; an omitted dataDir lands beside the app's own. */
        create: (name: string, dataDir?: string) => Promise<{ ok: boolean; error?: string; state: unknown }>;
        /** Native folder chooser for the create form; { ok: false } on cancel. */
        pickDir: () => Promise<{ ok: boolean; path?: string }>;
        /** {ok:false} when main refused (active local, failed folder delete); a
         * cancelled remote confirm and remote success answer nothing. */
        forget: (id: string, purge?: boolean) => Promise<{ ok: boolean; error?: string } | void>;
        /** `panel` "copy": that server's Copy this computer here panel; otherwise its Computer access. */
        onOpenSettings?: (callback: (computerId?: string | null) => void) => () => void;
      };
      /** Local main-window only. Hosted renderers cannot grant themselves access. */
      computerSharing?: {
        state(id: string): Promise<DesktopComputerSharing>;
        chooseFolder(): Promise<DesktopSharedFolder | null>;
        save(id: string, grant: Pick<DesktopComputerSharing, "folders" | "terminal" | "computer">): Promise<DesktopComputerSharing | null>;
        revoke(id: string): Promise<DesktopComputerSharing>;
        /** This computer's own record of what that server's bots did here, newest first. */
        activity(id: string): Promise<DesktopLendingActivity[]>;
      };
      confirm(message: string): Promise<boolean>;
      getCapabilities(): Promise<DesktopCapabilities>;
      onCapabilitiesChanged(cb: (capabilities: DesktopCapabilities) => void): () => void;
      remoteClient?: {
        active: boolean;
        state(): Promise<DesktopRemoteClientState>;
        pair(endpoint: string, code: string): Promise<DesktopRemoteClientState>;
        disconnect(): Promise<DesktopRemoteClientState>;
      };
      /** Keep this computer awake for scheduled routines; absent on remote
       * server pages and in older desktop builds. */
      routines?: {
        wakeState(): Promise<DesktopRoutineWake>;
        keepAwake(enabled: boolean): Promise<DesktopRoutineWake>;
      };
      companionAccount?: {
        state(): Promise<CompanionAccountState>;
        requestCode(email: string): Promise<CompanionAccountState>;
        verifyCode(email: string, code: string): Promise<CompanionAccountState>;
        retry(): Promise<CompanionAccountState>;
        /** Create or repair this computer's HTTPS address because a person
         * is pairing now. Absent in older desktop builds. */
        prepare?(): Promise<CompanionAccountState>;
        signOut(): Promise<CompanionAccountState>;
      };
      /** Local-shell-only bridge for trusted approval-mode transitions. It is
       * absent on remote server pages and in older desktop builds. */
      approvals?: {
        setMode(
          botId: string,
          mode: import("../../shared/approval-mode").ApprovalMode,
          options?: { acknowledgeLocalAuto?: boolean; threadId?: string; threadOnly?: boolean; allThreads?: boolean;
            refreshPermissions?: boolean;
            modelSelection?: import("../state/store").ModelSelection; updateBotDefault?: boolean },
        ): Promise<import("../state/store").Bot>;
      };
      localControl: {
        status(): Promise<LinuxLocalControlStatus>;
        enable(): Promise<LinuxLocalControlStatus>;
        disable(): Promise<LinuxLocalControlStatus>;
        retry(): Promise<LinuxLocalControlStatus>;
      };
      /** Arms one user-initiated display capture request from this frame. */
      beginScreenPreviewIntent(): boolean;
      screenFrame(): Promise<string | null>;
      androidDevice?: {
        status(): Promise<AndroidDeviceStatus>;
        frame(serial: string): Promise<{ serial: string; dataUrl: string }>;
        input(serial: string, payload: AndroidDeviceInput): Promise<void>;
      };
      /** Start native dictation. Call mode supplies endpointMs so silence
       * finalizes a turn; composer dictation omits it and remains manual. */
      speechStart(options?: { endpointMs?: number }): Promise<void>;
      speechStop(): Promise<void>;
      /** Finish capture and emit the recognizer's final transcript. */
      speechFinish?(): Promise<void>;
      /** This computer's page only: Settings → General's talk shortcut. */
      talkShortcut?: import("../../electron/talk-shortcut.mjs").TalkShortcutBridge;
      /** A call holds the microphone, so the talk shortcut waits. */
      callActive?(active: boolean): Promise<void>;
      onSpeechTranscript(
        cb: (line: { partial?: boolean; text?: string; error?: string }) => void,
      ): () => void;
      onSpeechEnd(cb: (info: { code: number | null; reason?: string }) => void): () => void;
      /** Absolute path of a dropped File ("" when the drag carried no
       * file on disk). Absent in older builds of the shell. */
      getPathForFile?(file: File): string;
      /** {mic} TCC status: granted|denied|not-determined|unknown. Screen
       * status is deliberately absent — macOS 15+ caches it per-process,
       * so it lies for the whole session after a grant. `pageMic`: whether
       * this app lets the asking page use the microphone (this computer's
       * page always; a server's page only on the person's own Cloud).
       * Absent in older builds of the shell. */
      permStatus(): Promise<{ mic: string; pageMic?: "allowed" | "refused" }>;
      /** Triggers the macOS microphone prompt; resolves true when granted. */
      permRequestMic(): Promise<boolean>;
      /** Opens System Settings on a privacy pane: mic|screen|speech|accessibility. */
      permOpenSettings(pane: "mic" | "screen" | "speech" | "accessibility"): Promise<void>;
      /** Relaunch the local desktop app through its normal shutdown cleanup. */
      relaunch?(): Promise<boolean>;
      /** Copies an engine install command and opens a blank terminal. False
       * when no terminal could be launched; the clipboard still has it. */
      openInstallTerminal?(command: string): Promise<boolean>;
      /** Writes plain text to the system clipboard; false on failure. Absent on older builds. */
      copyText?(text: string): Promise<boolean>;
      /** Opens an http(s) link in the user's default browser. */
      openExternal?(url: string): Promise<boolean>;
      /** Recolor the native window chrome for a skin; absent on older builds. */
      applySkin?(skin: string): Promise<boolean>;
      /** The renderer-drawn Windows caption buttons; absent outside the
       * frameless Windows shell (macOS/Linux/browser keep native chrome). */
      windowControls?: {
        minimize(): Promise<boolean>;
        toggleMaximize(): Promise<boolean>;
        close(): Promise<boolean>;
        state(): Promise<{ maximized: boolean }>;
        onMaximizedChanged(cb: (maximized: boolean) => void): () => void;
      };
      /** Receives a GitHub package URL opened through openmausbot://install. */
      onPackageInstall?(cb: (url: string) => void): () => void;
      /** Receives a chat link (openmausbot://thread/… or openmausbot://bot/…)
       * opened from outside the app. */
      onChatLink?(cb: (link: string) => void): () => void;
      /** The desktop shell's app-menu Preferences… item was activated; open
       * app Settings. Local-shell only: remote server pages never receive
       * the channel, and the bridge is absent in the browser. "cloud" is the
       * openmausbot://cloud link (Settings → OMB Cloud, opened by the link). */
      onOpenAppSettings?(cb: (section?: "organization" | "cloud" | "cloud-settings" | "cloud-add" | "cloud-add-howto") => void): () => void;
      /** Updates the native Dock/taskbar unread indicator. */
      setUnreadCount?(count: number): void;
      /** Opens a live desktop as a sandboxed window owned by OpenMausBot. */
      desktopViewer?: {
        open(url: string, title: string, contextId: string): Promise<boolean>;
        /** Closes the live-desktop window, but only when it belongs to this bot. */
        close(contextId: string): Promise<boolean>;
        /** The current viewer state, for a panel to initialize from on mount. */
        currentState(): Promise<{ open: boolean; contextId: string | null }>;
        onState(cb: (state: { open: boolean; contextId: string | null }) => void): () => void;
      };
      /** Two Local VM viewers embedded in one app window. URLs are accepted
       * only by main-process validation and never return over this bridge. */
      desktopWorkspace?: {
        open(input: {
          contextId: string;
          url: string;
          title: string;
          bounds: DesktopWorkspaceBounds;
        }): Promise<DesktopWorkspaceState>;
        layout(items: Array<{
          contextId: string;
          bounds: DesktopWorkspaceBounds;
          visible: boolean;
        }>): Promise<boolean>;
        setInteractive(contextId: string | null): Promise<boolean>;
        close(contextId?: string): Promise<boolean>;
        onState(cb: (state: DesktopWorkspaceState) => void): () => void;
      };
      /** Native folder picker; resolves null when the user cancels. */
      pickFolder?(current?: string): Promise<string | null>;
      /** Writes the redacted diagnostics report to a user-chosen file;
       * resolves the path, or null when cancelled. */
      exportDiagnostics?(): Promise<string | null>;
      /** Asks where to save a bot-created file (inside ~/.openmausbot), copies
       * it there and reveals it. Resolves the chosen path, or null if the
       * user cancelled the dialog. */
      saveFile?(filePath: string): Promise<string | null>;
      /** Points this computer's file manager at a file a bot linked outside
       * its workspace, without opening or reading it. Local app only. */
      revealInFolder?(filePath: string): Promise<"shown" | "missing" | "invalid">;
      /** Opens this app's logs folder in Explorer or Finder and says where it is. */
      openLogsFolder?(): Promise<{ folder: string; opened: boolean; error?: string }>;
      /** This app's own login item, which opens the window. `available`: false in a build that cannot add one. */
      openAtLogin?: { state(): Promise<{ available: boolean; on: boolean }>; set(on: boolean): Promise<{ available: boolean; on: boolean }> };
      /** Save a provider credential through Electron's OS-backed store. */
      setCredential?(
        name: "composioApiKey" | "xaiApiKey" | "boxToken" | "opencodeGoApiKey" | "ttsKey" | "fishAudioKey" | "jevApiKey" | "openrouterDeciderKey" | "workersAiToken" | "openaiImageApiKey" | "customImageApiKey" | "openaiLiveKey" | "tregApiKey" | "postizApiKey",
        value: string,
      ): Promise<ConfigStatus>;
      /** In-app auto-update (packaged app only; dormant in dev). Updates
       * download by themselves. On this computer's page and the person's own
       * Cloud page; any other server's page gets no state. onState fires
       * with the current state, then on transitions. */
      updater?: {
        check(): Promise<void>;
        /** apply the download: quit-and-install, or copy the command and open
         * a terminal. On a server's page, only from the person's click. */
        install(): Promise<void>;
        /** The person saw the line that the app updated itself: it is not shown again. */
        seen?(): Promise<void>;
        onState(cb: (s: UpdaterState) => void): () => void;
      };
    };
  }
}

export interface LinuxLocalControlStatus {
  enabled: boolean;
  status: "disabled" | "checking" | "starting" | "ready" | "error" | "stopped" | "unavailable";
  reasonCode?: string;
  message?: string;
  driverPath?: string;
  driverVersion?: string;
  driverSource?: "bundled" | "environment" | "user-local" | "path";
  session?: "x11" | "wayland" | "headless" | "unknown";
  compositor?: "gnome-mutter";
  warnings?: Array<{ label: string; status: string; message: string; detail?: string }>;
}

export interface UpdaterState {
  status:
    | "idle"
    | "checking"
    | "downloading"
    /** downloaded bytes are being staged by the native macOS updater */
    | "preparing"
    | "downloaded"
    | "installing"
    /** the command is on the clipboard; the user finishes in a terminal */
    | "handed-off"
    | "error";
  version?: string;
  /** the release's notes as published (HTML or Markdown), when the feed has them */
  releaseNotes?: string;
  percent?: number;
  message?: string;
  /** native work may still be running; recovery requires an app restart */
  retryable?: boolean;
  /**
   * How the download gets applied. "restart" quits and installs in place (an
   * Ubuntu .deb asks for the password once, installs and reopens);
   * "handoff" copies the install command and opens a terminal so the user
   * can finish — rpm/pacman builds, and a .deb where no password prompt
   * can be shown, use this.
   */
  installMode?: "restart" | "handoff";
  /** hand-off only: the install command, already on the clipboard */
  command?: string;
  /** hand-off only: whether a terminal was opened to paste it into */
  terminalOpened?: boolean;
  /** downloaded only: the app installs it by itself the next time the person is away and nothing is running */
  installsByItself?: boolean;
  /** the version the app updated itself to while the person was away, until they have seen it said */
  updated?: string;
}

export interface CompanionAccountState {
  available: boolean;
  status: "signed-out" | "connecting" | "ready" | "error";
  email?: string;
  endpoint?: string;
  message?: string;
}

export type AndroidUsbDevice = {
  serial: string;
  state: string;
  connection: "usb";
  model: string;
  product?: string;
  transportId?: string;
};

export type AndroidDeviceStatus = {
  available: boolean;
  reasonCode?: "adb-unavailable" | "adb-failed";
  message?: string;
  devices: AndroidUsbDevice[];
};

export type AndroidDeviceInput =
  | { type: "tap"; x: number; y: number; width: number; height: number }
  | {
      type: "swipe";
      fromX: number;
      fromY: number;
      toX: number;
      toY: number;
      durationMs: number;
      width: number;
      height: number;
    }
  | { type: "key"; key: string; width?: number; height?: number }
  | { type: "text"; text: string; width?: number; height?: number };
