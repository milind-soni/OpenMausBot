export declare const ISLAND_MESSAGE_LIMITS: Readonly<{
  maxFrames: number; maxFrameBytes: number; maxOmiChars: number; maxPromptChars: number;
}>;

/** An explicit user send uploads recent captured images and quotes external Omi context. */
export declare function prepareIslandMessage(input: {
  text: string;
  frames?: Array<{ dataUrl: string; capturedAt?: number; displayId?: string; hash?: string }>;
  omiContext?: string;
  request: (route: string, init?: RequestInit) => Promise<Response>;
  signal?: AbortSignal;
}): Promise<string>;
