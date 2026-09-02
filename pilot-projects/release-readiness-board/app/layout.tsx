import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Release Room · 发布验收室",
  description: "用于验证发布检查项、阻塞风险与上线就绪度的非生产协作看板。",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
