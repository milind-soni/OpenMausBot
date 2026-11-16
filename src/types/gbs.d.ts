import type { PreviewTestingSession } from "@/lib/previewTesting";
// The narrow bridge the Electron preload exposes. Absent in the browser.
export {};

declare global {
  interface Window {
    gbs?: {
      background?: { get(): Promise<boolean>; set(enabled: boolean): Promise<boolean> };
      platform: string;
      previewTesting?: {
        start(): Promise<PreviewTestingSession[]>;
        register(input: { sessionId: string; webContentsId: number }): Promise<{ ok: boolean }>;
        control(input: { sessionId: string; action: "pause" | "resume" | "close" }): Promise<void>;
        onActive(cb: (id: string) => void): () => void;
        onSessions(cb: (sessions: PreviewTestingSession[]) => void): () => void;
      };
      screenFrame(): Promise<string | null>;
      /** Screenshots the mobile preview <webview>. fullPage captures beyond
       * the visible viewport (via the CDP debugger); otherwise just the
       * currently visible area. Returns a data: URL, or null on failure. */
      previewScreenshot(input: { webContentsId: number; fullPage: boolean }): Promise<string | null>;
      speechStart(): Promise<void>;
      speechStop(): Promise<void>;
      onSpeechTranscript(
        cb: (line: { partial?: boolean; text?: string; error?: string }) => void,
      ): () => void;
      onSpeechEnd(cb: (info: { code: number | null }) => void): () => void;
      /** {mic} TCC status: granted|denied|not-determined|unknown. Screen
       * status is deliberately absent — macOS 15+ caches it per-process,
       * so it lies for the whole session after a grant. */
      permStatus(): Promise<{ mic: string }>;
      /** Triggers the macOS microphone prompt; resolves true when granted. */
      permRequestMic(): Promise<boolean>;
      /** Opens System Settings on a privacy pane: mic|screen|speech. */
      permOpenSettings(pane: "mic" | "screen" | "speech"): Promise<void>;
      /** Local project management. All filesystem access stays in Electron main. */
      projects: {
        list(): Promise<ProjectRecord[]>;
        chooseDirectory(options?: {
          title?: string;
          buttonLabel?: string;
          defaultPath?: string;
        }): Promise<string | null>;
        addExisting(projectPath: string): Promise<ProjectRecord>;
        create(input: { parentPath: string; name: string }): Promise<ProjectRecord>;
        clone(input: { repositoryUrl: string; destinationPath: string }): Promise<ProjectRecord>;
        open(projectPath: string): Promise<void>;
      };
      /** In-app auto-update (packaged app only; dormant in dev). onState
       * fires immediately with the current state, then on transitions. */
      updater?: {
        check(): Promise<void>;
        download(): Promise<void>;
        /** quit-and-install the downloaded update */
        install(): Promise<void>;
        onState(cb: (s: UpdaterState) => void): () => void;
      };
    };
  }
}

export interface UpdaterState {
  status: "idle" | "checking" | "available" | "downloading" | "downloaded" | "error";
  version?: string;
  percent?: number;
  message?: string;
}

export interface ProjectRecord {
  id: string;
  name: string;
  mention: string;
  path: string;
  source: "existing" | "created" | "github";
  repositoryUrl?: string;
  addedAt: number;
  missing: boolean;
}
