import type { Metadata } from "next";
import { Archivo, Bricolage_Grotesque, Martian_Mono } from "next/font/google";
import { isMockMode } from "@/lib/uber";
import "./globals.css";

const display = Bricolage_Grotesque({
  subsets: ["latin"],
  weight: ["600", "700", "800"],
  variable: "--font-display-loaded",
});

const body = Archivo({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-body-loaded",
});

const mono = Martian_Mono({
  subsets: ["latin"],
  weight: ["400", "600", "700"],
  variable: "--font-mono-loaded",
});

export const metadata: Metadata = {
  title: "Direct Dispatch",
  description: "A courier dispatch desk built on the Uber Direct API.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const mock = isMockMode();

  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <body>
        <div className="hazard-tape" />
        <div className="shell">
          <header className="masthead">
            <div className="wordmark">
              <h1>
                Direct <em>Dispatch</em>
              </h1>
              <span className="stencil" aria-hidden="true">
                ///
              </span>
            </div>

            <div className="row">
              <span className="mode-badge" data-mode={mock ? "mock" : "live"}>
                <span className="pulse" />
                {mock ? "Simulated courier" : "Live credentials"}
              </span>
              <nav className="nav">
                <a href="/">New order</a>
                <a href="/orders">Orders</a>
              </nav>
            </div>
          </header>

          {children}
        </div>
      </body>
    </html>
  );
}
