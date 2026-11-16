export interface PickerDraft {
  draftId: string;
  recording: boolean;
  allowImages: boolean;
  imageSlots: number;
  imageBytes: number;
  onFiles(files: File[]): Promise<void>;
  onText(text: string): void;
  getText(): string;
}
let reader: (() => PickerDraft) | undefined;
export function readPickerDraft(): PickerDraft | undefined {
  return reader?.();
}
export function registerDraft(read: () => PickerDraft) {
  reader = read;
  return () => {
    if (reader === read) reader = undefined;
  };
}
