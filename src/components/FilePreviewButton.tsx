import type { MessageAttachmentContext } from "./AttachmentPreview";
import { HtmlFileButton, isHtmlFile } from "./HtmlFilePreview";
import { TableFileButton } from "./TableFilePreview";

export function FilePreviewButton({ path, name, message }: { path: string; name: string; message: MessageAttachmentContext }) {
  if (isHtmlFile(name) || isHtmlFile(path)) return <HtmlFileButton path={path} name={name} message={message} />;
  return <TableFileButton path={path} name={name} message={message} />;
}
