---
title: Previewing pages and files
summary: Check websites and HTML across device sizes, and read documents and images in a full-screen viewer.
updated: 2026-11-13
owner: Z
---

# Previewing pages and files

Use **Preview** to check websites and project HTML across phone, tablet, laptop, and desktop screens. Markdown, PDFs and images use one full-screen file viewer, without device sizes, rotation or Canvas. Saved device settings apply only when you return to a website or HTML file.

You can use Preview in two places:

1. **Quick preview panel** — a side panel next to your chat for fast checks while you talk to a bot.
2. **Preview page** — a full-screen workspace (in the left sidebar) with **Single** mode and a multi-screen **Canvas** mode.

---

## What you can preview

- **Web addresses** — any `http://` or `https://` address, including local servers like `http://localhost:3000` or `http://localhost:5173`.
- **Project files** — files inside any project you have added in **Projects**:
  - Web pages (`.html`, `.htm`)
  - Documents (`.pdf`, `.md`, `.markdown`)
  - Images (`.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`, `.svg`)

> **Safety note for local addresses:** The first time you open a local or private address (like `localhost`), Gerer Build Studio asks you to confirm that you trust the server running there.

---

## Using the quick preview panel in chat

1. Open any bot chat or room and click the **Preview** icon in the top bar.
2. Enter a web address and click **Open**, or click the **folder button** to pick a file from a project.
3. For websites and HTML, choose a screen size from the **Size** menu (**Phone**, **Tablet**, **Laptop**, **Desktop**, or **Custom size**).
4. Use the toolbar to:
   - **Go back**, **go forward**, or **reload**
   - **Rotate** (`⇄`) to swap width and height
   - Change **Zoom** (**Fit**, **50%**, **75%**, or **100%**)
   - Click the **camera button** to send a screenshot of the visible area or the full page to your current chat
   - Full-page screenshots scroll through the page and restore your position afterward. Sticky and fixed elements appear once. Capture uses the current viewport layout and produces one image pixel per CSS pixel; scrolling can trigger lazy-loaded content.
   - Click **Open in Preview page** (`⤢`) to carry your current address and size into the full Preview page

---

## Using the full Preview page

Click **Preview** in the left sidebar to open the full workspace.

### Single mode

Device controls and Canvas are available for websites and HTML only. Other files fill the viewer.

**Single mode** focuses on one screen size at a time with room for large laptop and desktop layouts:

- Click any size tab in the second bar (**iPhone SE**, **iPhone 15 / 16**, **Pixel**, **iPad mini**, **iPad Pro 11"**, **Laptop**, **Desktop**, **Wide Desktop**, or **Custom**) to switch sizes immediately.
- Press `[` or `]` on your keyboard to step through sizes.
- Press `R` to rotate the active screen.

### Canvas mode

Switch to **Canvas** in the top-right to compare several screen sizes side by side on a single board:

- **Sync scroll (desktop app):** Match vertical page scrolling across live website or HTML artboards. Panels inside a page may scroll separately. Browser previews cannot sync these pages; scroll each preview separately.
- **Choose sizes:** Click size chips in the second bar (or pick **Default 4**, **All phones**, or **All sizes**) to add or remove artboards.
- **Pan around:** Scroll with two fingers on a trackpad, or hold `Space` and drag anywhere on the board.
- **Zoom in and out:** Hold `⌘` (macOS) or `Ctrl` (Windows/Linux) while scrolling, or use the `-`, `+`, `100%`, and `Fit all` controls in the bottom-right corner.
- **Keyboard shortcuts:** Press `0` for **Fit all**, `1` for **100%**, and `+` or `-` to zoom in or out.
- **Performance cap:** To keep your computer fast, up to **6 artboards** run live at the same time. If you open 7 or more sizes, extra artboards show a **Snapshot** badge—hover or click any snapshot to make it live immediately.

---

## Automatic refresh when files change

When you preview a file from a registered project, **Refresh automatically when files change** is turned on by default. Whenever you or a bot saves changes to that file, the preview updates on its own.

---

## Sharing previews to a bot or room

1. Click **Share to chat…** in the top-right of the Preview page (or the camera icon on any Canvas artboard).
2. For websites and HTML, choose **Current size** or **All selected sizes**. Other files share a single full-screen capture. Browser PDFs share a link and note because their viewer cannot provide a screenshot; web page screenshots also need the desktop app.
3. Pick **Visible area** or **Full page**.
4. Select the **Bot** or **Room** you want to send the screenshots to, add an optional note, and click **Send**.

---

## When a site blocks embedding

Some public websites send security headers (`X-Frame-Options` or `Content-Security-Policy`) that block loading inside a preview frame. When that happens, Preview shows **This site doesn't allow embedding** with an **Open in new tab** button so you can view the page directly in your browser.
