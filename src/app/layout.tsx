import type { Metadata, Viewport } from "next";
import pkg from "../../package.json";
import "./globals.css";

export const metadata: Metadata = {
  title: "Velvarr",
  description: "Private media library",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#140c15",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-canvas text-ink antialiased">
        {children}
        <footer className="app-footer">
          <a
            href="https://github.com/Skare69/velvarr"
            target="_blank"
            rel="noreferrer noopener"
          >
            Velvarr
          </a>
          <span>
            v{pkg.version} ({pkg.released})
          </span>
        </footer>
      </body>
    </html>
  );
}
