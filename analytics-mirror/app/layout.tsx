import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "A2W Analytics",
  description: "Heat pump history & analytics (read-only cloud mirror)",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
