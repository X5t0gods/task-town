import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "任务小镇 · 让好习惯慢慢发光",
  description: "家长发布任务，孩子完成打卡，家长验收后赚取星星、兑换小愿望。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}
