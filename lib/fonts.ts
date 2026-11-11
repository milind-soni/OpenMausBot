import localFont from "next/font/local";

// Inter Variable (rsms Inter 4, wght 100–900 + opsz 14–32), vendored from
// @fontsource-variable/inter so the page never asks Google Fonts for CSS.
// The same file serves the UI (opsz follows the font size) and Inter Display
// for headings (--font-display pins opsz to 32). tokens.css reads --font-inter.
export const interFont = localFont({
  src: [{ path: "../node_modules/@fontsource-variable/inter/files/inter-latin-opsz-normal.woff2", weight: "100 900", style: "normal" }],
  variable: "--font-inter",
  display: "swap",
  preload: true,
  fallback: ["ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "sans-serif"],
});
