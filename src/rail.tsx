import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ChromeRail } from "./components/ChromeRail";
import { PageBoundary } from "./components/PageBoundary";
import { bootstrapBrand } from "./lib/brand";
import { applyFont, readFont } from "./lib/fonts";
import { settleInterfaceMode } from "./lib/new-look";
import { loadPageLanguage } from "./lib/language-preference";
import { applySkinChoice, readSkinChoice } from "./lib/skins";
import "./styles.css";

// The window's own rail of places (electron/chrome-rail.mjs): see-through but for the rail and its open sheets. Only
// the desktop's preload gives this app's page a rail; anywhere else this address is the app.
if (window.ogb?.rail?.expand) {
  settleInterfaceMode();
  applySkinChoice(readSkinChoice());
  applyFont(readFont());
  document.documentElement.style.background = document.body.style.background = "transparent";
  void Promise.all([bootstrapBrand(), loadPageLanguage()]).then(() => {
    createRoot(document.getElementById("root")!).render(<StrictMode><PageBoundary><ChromeRail /></PageBoundary></StrictMode>);
  });
} else {
  location.replace(`/${location.search}${location.hash}`);
}
