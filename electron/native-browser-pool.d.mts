import type { BrowserWindow, Session, WebContents, WebContentsView, WebPreferences } from 'electron';

export type NativeBrowserActor =
  | { kind: 'agent' }
  | { kind: 'viewer'; viewerId: string }
  | { kind: 'system' };

export interface NativeBrowserOpenOptions {
  persistent: boolean;
  proxyPort?: number;
}

export interface NativeBrowserInput {
  viewerId: string | null;
  targetId: string;
  epoch: number;
}

export interface NativeBrowserPoolOptions {
  createView(webPreferences: WebPreferences & { focusOnNavigation: false }, existingWebContents?: WebContents): WebContentsView;
  sessionForProfile(profileId: string, openOptions: NativeBrowserOpenOptions): Session | Promise<Session>;
  getOwner(): BrowserWindow | null | undefined;
  createRenderOwner(): BrowserWindow;
  product: string;
  onMessage?(profileId: string, jsonCDP: string): void;
  onClose?(profileId: string, reason: string): void;
  onInput?(profileId: string, input: NativeBrowserInput): void;
  onFocusAddress?(profileId: string, input: { targetId: string; viewerId: string | null }): void;
  onActivity?(profileId: string, input: { targetId: string; viewerId: string }): void;
  maxProfiles?: number;
  maxTargets?: number;
  maxTargetsPerProfile?: number;
}

export interface NativeBrowserPool {
  open(input: NativeBrowserOpenOptions & { profileId: string }): Promise<{ profileId: string; product: string; epoch: number }>;
  send(input: { profileId: string; epoch?: number; actor?: NativeBrowserActor; message: string }): Promise<void>;
  lease(input: { profileId: string; viewerId: string | null; ready: boolean }): number;
  layout(input: {
    profileId: string;
    targetId: string;
    viewerId: string;
    bounds: { x: number; y: number; width: number; height: number };
    visible: boolean;
    canInput?: boolean;
    canTake?: boolean;
  }): void;
  close(profileId: string): Promise<void>;
  /** Erases an owned Session already opened by this pool. The adapter resolves persisted unopened profiles. */
  erase(profileId: string): Promise<void>;
  destroy(): Promise<void>;
}

export function createNativeBrowserPool(options: NativeBrowserPoolOptions): NativeBrowserPool;
