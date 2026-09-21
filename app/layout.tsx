import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI 客服 Generative UI",
  description: "Tool Calling + 组件白名单 + SSE 多事件流 —— 协议层完整实现",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
