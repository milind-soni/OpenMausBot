import { isRecord, isWebUrl, widgetActions, type WidgetAction, type WidgetActionEntry, type WidgetPayload } from "./widget.ts";

/** `open_url` is handled on the device. The url was checked as http(s) when the widget was stored. */
export function urlActionTarget(action: WidgetAction): string | undefined {
  if (action.type !== "open_url" || !isRecord(action.payload)) return undefined;
  return isWebUrl(action.payload.url, ["http:", "https:"]) ? action.payload.url : undefined;
}

/** The device-handled entry a ref names, if it names one. */
export function clientWidgetAction(payload: WidgetPayload, ref: string): WidgetActionEntry | undefined {
  const entry = widgetActions(payload.root).find((candidate) => candidate.ref === ref);
  return entry?.client ? entry : undefined;
}
