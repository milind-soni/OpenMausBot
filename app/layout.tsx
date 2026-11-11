import type { Metadata, Viewport } from "next";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/controls.css";
import "./styles/pickers.css";
import "./styles/shell.css";
import "./styles/project.css";
import "./styles/board.css";
import "./styles/issue.css";
import "./styles/inbox.css";
import "./styles/chat.css";
import "./styles/call.css";
import "./styles/draw.css";
import "./styles/library.css";
import "./styles/repo.css";
import "./styles/feedback.css";
import "./styles/settings.css";
import "./styles/auth.css";
import "./styles/motion.css";
import { Providers } from "./providers";
import { interFont } from "@/lib/fonts";
import { siteUrl } from "@/lib/site";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: "Origin",
  description: "Issues, chat, calls and a shared canvas for your team.",
  openGraph: { title: "Origin", description: "Issues, chat, calls and a shared canvas for your team.", images: [{ url: "/og.png", width: 1200, height: 630, alt: "The Origin workspace" }] },
  icons: [{ rel: "icon", url: "/origin.svg" }],
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#08090a",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={interFont.variable} suppressHydrationWarning>
      <body suppressHydrationWarning>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
