export declare const HIDDEN_ARG: string;
export declare function autostartEntry(exec: string, options?: { lending?: boolean }): string;
type LoginItem = { follow(on: boolean): void; startedHidden(): boolean; available(): boolean; chosen(): boolean; choose(on: boolean): void };
export declare function createOpenAtLogin(options: {
  app: {
    isPackaged: boolean;
    getLoginItemSettings(options?: { args?: string[] }): { openAtLogin: boolean; wasOpenedAtLogin?: boolean; launchItems?: { name: string; enabled?: boolean }[] };
    setLoginItemSettings(settings: { openAtLogin: boolean; args?: string[]; name?: string }): void;
  };
  file: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home: string;
  argv?: string[];
  execPath?: string;
}): LoginItem;
export declare function installOpenAtLogin(options: {
  ipcMain: { handle(channel: string, handler: (...args: any[]) => unknown): void };
  guard: (channel: string, handler: (...args: any[]) => unknown) => (...args: any[]) => unknown;
  loginItem: LoginItem;
  changed: () => void;
}): void;
