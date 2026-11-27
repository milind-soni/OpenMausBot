import type { MessageAttachmentContext } from "./AttachmentPreview";
import { HtmlFileButton, isHtmlFile } from "./HtmlFilePreview";
import { TableFileButton } from "./TableFilePreview";

export function FilePreviewButton({ path, shownPath, name, message }: { path: string; shownPath?: string; name: string; message: MessageAttachmentContext }) {
  if (isHtmlFile(name) || isHtmlFile(path)) return <HtmlFileButton path={path} shownPath={shownPath} name={name} message={message} />;
  return <TableFileButton path={path} shownPath={shownPath} name={name} message={message} />;
}
