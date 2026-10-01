// noVNC 1.7 exports its ESM entry at the package root. DefinitelyTyped's
// declarations still name the old 1.6 entry point.
declare module "@novnc/novnc" {
  export { default } from "@novnc/novnc/lib/rfb";
}
