import { appendDraftAttachments, replaceDraftAttachment } from "./drafts";
import { handoffAttachmentImagePreview, imageAttachmentFromFile, optimisticImageAttachment, releaseAttachmentImagePreview, type Attachment } from "./composer-attachments";

export async function uploadDraftImage(draftId: string, file: File): Promise<Attachment | null> {
  const optimistic = optimisticImageAttachment(file);
  if (!optimistic) return null;
  appendDraftAttachments(draftId, [optimistic]);
  try {
    const completed = await imageAttachmentFromFile(file, optimistic);
    if (!completed) {
      replaceDraftAttachment(draftId, optimistic.id, null);
      releaseAttachmentImagePreview(optimistic);
      return null;
    }
    handoffAttachmentImagePreview(completed.path, completed.previewUrl);
    if (!replaceDraftAttachment(draftId, optimistic.id, completed)) {
      releaseAttachmentImagePreview(completed);
    }
    return null;
  } catch (error) {
    replaceDraftAttachment(draftId, optimistic.id, null);
    releaseAttachmentImagePreview(optimistic);
    throw error;
  }
}
