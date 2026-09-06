// The narrow bridge the Electron preload exposes. Absent in the browser.

declare global {
/** The package.json version, inlined by Vite's define at build time. */
const __APP_VERSION__: string;

type NativeSkillRecordingEvent = {
  type: "app" | "click" | "scroll" | "key" | "typing" | "clipboard" | "download";
  atMs: number;
  app?: string;
  windowTitle?: string;
  x?: number;
  y?: number;
  button?: "left" | "right" | "other";
  deltaY?: number;
  keycode?: number;
  meta?: boolean;
  control?: boolean;
  option?: boolean;
  shift?: boolean;
  /** Element identity for a click, from the accessibility tree. */
  role?: string;
  name?: string;
  identifier?: string;
  ancestry?: string[];
  /** Typed keystroke count (never the characters themselves). */
  keyCount?: number;
  /** Clipboard action kind — never its contents. */
  op?: "copy" | "cut" | "paste";
  /** Downloaded file name and its origin URLs. */
  filename?: string;
  whereFroms?: string[];
};

type SkillRecordingPayload = {
  name: string;
  description: string;
  durationMs: number;
  transcript: string;
  transcription?: { provider: "assemblyai"; model: string };
  audio?: string;
  events: Array<{
    type: "app" | "click" | "scroll" | "shortcut" | "typing" | "clipboard" | "download";
    atMs: number;
    app?: string;
    windowTitle?: string;
    direction?: "up" | "down";
    shortcut?: string;
    keyCount?: number;
    screenshot?: string;
    /** Element identity for a click. */
    role?: string;
    name?: string;
    identifier?: string;
    ancestry?: string[];
    /** Clipboard action kind — never its contents. */
    op?: "copy" | "cut" | "paste";
    /** Downloaded file name and its origin URLs. */
    filename?: string;
    whereFroms?: string[];
  }>;
};

  type DesktopCapabilities = {
    host: {
      platform: "darwin" | "linux" | "win32" | "other";
      /** The user's home folder, for showing paths as ~/… */
      homeDir?: string;
      label: string;
      session: "x11" | "wayland" | "headless" | "unknown";
      packaged: boolean;
    };
    windowChrome: "mac-inset" | "native";
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

  interface DesktopRemoteClientState {
    active: boolean;
    endpoint?: string;
    serverName?: string;
    deviceId?: string;
  }

  interface Window {
    ogb?: {
      platform: NodeJS.Platform;
      /** Saved servers and the active one (desktop Server menu). Present on
       * the local server's UI; a remote server's page sees a reduced bridge. */
      environments?: {
        state: () => Promise<{
          localOrigin: string;
          remote: boolean;
          activeId: string;
          environments: Array<{ id: string; name: string; origin: string }>;
        }>;
        switch: (id: string) => Promise<void>;
        addFromLink: (link: string) => Promise<void>;
        forget: (id: string) => Promise<void>;
      };
      getCapabilities(): Promise<DesktopCapabilities>;
      onCapabilitiesChanged(cb: (capabilities: DesktopCapabilities) => void): () => void;
      remoteClient?: {
        active: boolean;
        state(): Promise<DesktopRemoteClientState>;
        pair(endpoint: string, code: string): Promise<DesktopRemoteClientState>;
        disconnect(): Promise<DesktopRemoteClientState>;
      };
      companionAccount?: {
        state(): Promise<CompanionAccountState>;
        requestCode(email: string): Promise<CompanionAccountState>;
        verifyCode(email: string, code: string): Promise<CompanionAccountState>;
        retry(): Promise<CompanionAccountState>;
        signOut(): Promise<CompanionAccountState>;
      };
      /** Local-shell-only bridge for trusted approval-mode transitions. It is
       * absent on remote server pages and in older desktop builds. */
      approvals?: {
        setMode(
          botId: string,
          mode: import("../../shared/approval-mode").ApprovalMode,
          options?: { acknowledgeLocalAuto?: boolean },
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
      onSpeechTranscript(
        cb: (line: { partial?: boolean; text?: string; error?: string }) => void,
      ): () => void;
      onSpeechEnd(cb: (info: { code: number | null; reason?: string }) => void): () => void;
      skillRecorder?: {
        permissions(): Promise<{ supported: boolean; reason?: string }>;
        start(): Promise<{ recording: boolean }>;
        stop(): Promise<{ recording: boolean }>;
        save(payload: SkillRecordingPayload): Promise<{ id: string; path: string; events: number }>;
        onEvent(cb: (event: NativeSkillRecordingEvent) => void): () => void;
        onEnd(cb: (info: { code: number | null; reason?: string }) => void): () => void;
      };
      transcription?: {
        status(): Promise<{ configured: boolean }>;
        setKey(value: string): Promise<{ configured: boolean }>;
        streamingToken(): Promise<{ token: string; expiresInSeconds: number }>;
      };
      /** Absolute path of a dropped File ("" when the drag carried no
       * file on disk). Absent in older builds of the shell. */
      getPathForFile?(file: File): string;
      /** {mic} TCC status: granted|denied|not-determined|unknown. Screen
       * status is deliberately absent — macOS 15+ caches it per-process,
       * so it lies for the whole session after a grant. */
      permStatus(): Promise<{ mic: string }>;
      /** Triggers the macOS microphone prompt; resolves true when granted. */
      permRequestMic(): Promise<boolean>;
      /** Opens System Settings on a privacy pane: mic|screen|speech|accessibility. */
      permOpenSettings(pane: "mic" | "screen" | "speech" | "accessibility"): Promise<void>;
      /** Copies an engine install command and opens a blank terminal. False
       * when no terminal could be launched; the clipboard still has it. */
      openInstallTerminal?(command: string): Promise<boolean>;
      /** Opens an http(s) link in the user's default browser. */
      openExternal?(url: string): Promise<boolean>;
      /** Recolor the native window chrome for a skin; absent on older builds. */
      applySkin?(skin: string): Promise<boolean>;
      /** Receives a GitHub package URL opened through openmausbot://install. */
      onPackageInstall?(cb: (url: string) => void): () => void;
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
      /** Save a provider credential through Electron's OS-backed store. */
      setCredential?(
        name: "composioApiKey" | "xaiApiKey" | "boxToken" | "opencodeGoApiKey" | "ttsKey" | "openaiImageApiKey",
        value: string,
      ): Promise<ConfigStatus>;
      /** In-app auto-update (packaged app only; dormant in dev). onState
       * fires immediately with the current state, then on transitions. */
      updater?: {
        check(): Promise<void>;
        download(): Promise<void>;
        /** apply the download: quit-and-install, or copy the command and open a terminal */
        install(): Promise<void>;
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
    | "available"
    | "downloading"
    | "downloaded"
    | "installing"
    /** the command is on the clipboard; the user finishes in a terminal */
    | "handed-off"
    | "error";
  version?: string;
  percent?: number;
  message?: string;
  /**
   * How the download gets applied. "restart" quits and installs in place;
   * "handoff" copies the install command and opens a terminal so the user
   * can finish — Ubuntu .deb (and rpm/pacman) builds use this.
   */
  installMode?: "restart" | "handoff";
  /** hand-off only: the install command, already on the clipboard */
  command?: string;
  /** hand-off only: whether a terminal was opened to paste it into */
  terminalOpened?: boolean;
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
