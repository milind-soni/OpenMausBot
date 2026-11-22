/** Whether this session can show the root prompt that installs a downloaded `.deb`. */
export declare function canInstallElevated(options?: {
  platform?: string;
  env?: Record<string, string | undefined>;
  pkexec?: string;
  access?: (path: string, mode?: number) => void;
}): boolean;

/** electron-updater's SHA-512 (base64 or hex) as lowercase hex, or null when it cannot be read. */
export declare function sha512Hex(value: unknown): string | null;

export interface ElevatedInstallResult {
  ok: boolean;
  reason?: "unverifiable" | "unavailable" | "declined" | "refused" | "checksum" | "failed";
  detail?: string;
  messageKey?: string;
  messageParams?: Record<string, string>;
}

export declare function installPackageElevated(options?: {
  file?: string;
  sha512?: string;
  pkexec?: string;
  run?: (...args: unknown[]) => unknown;
  stat?: (path: string) => { isFile(): boolean };
  timeout?: number;
}): Promise<ElevatedInstallResult>;

export declare const PKEXEC: string;
export declare const ELEVATED_INSTALL_SCRIPT: string;
