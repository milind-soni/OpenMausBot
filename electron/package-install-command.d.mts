/** The install command each system package type is handed over with. */
export declare const HAND_OFF_PACKAGE_TYPES: readonly string[];

export declare function shellQuote(value: string): string;

export declare function packageInstallCommand(packageType: string, file: string): string;

export declare function stagedInstallFile(files: readonly string[] | null | undefined, exists?: (file: string) => boolean): string | undefined;

export declare function linuxPackageType(options?: {
  platform?: string;
  resourcesPath?: string;
  appImage?: string;
  readMarker?: (file: string) => string | null;
}): string | null;
