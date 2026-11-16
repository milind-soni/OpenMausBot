export interface PickerRead {
  scopeKey: string;
  connected: boolean;
  control: { controller: string } | null;
  surface(): HTMLCanvasElement | null;
  send(message: {
    type: "ombElementInspect";
    requestId: string;
    x: number;
    y: number;
    capture: boolean;
    document?: string;
  }): unknown;
  take(): void;
}
export function mountBrowserPicker(
  host: HTMLElement,
  read: () => PickerRead,
): () => void;
export function browserMessage(
  key: string,
  message: Readonly<Record<string, unknown>>,
): void;
