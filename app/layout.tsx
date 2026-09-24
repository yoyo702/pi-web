import type { Metadata, Viewport } from "next";
import { Noto_Sans_Mono } from "next/font/google";
import "./globals.css";
import { AgentationDevTools } from "@/components/AgentationDevTools";
import { MobileDevToolsGuard } from "@/components/MobileDevToolsGuard";
import { MobileFullscreenPrompt } from "@/components/MobileFullscreenPrompt";

const notoSansMono = Noto_Sans_Mono({
  subsets: ["latin", "cyrillic"],
  variable: "--font-noto-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "TianForge pi",
  description: "TianForge, a browser workspace built on the pi coding agent",
  applicationName: "TianForge pi",
  manifest: "/manifest.webmanifest",
  formatDetection: {
    telephone: false,
  },
  appleWebApp: {
    capable: true,
    title: "TianForge pi",
    statusBarStyle: "black-translucent",
  },
  icons: {
    apple: "/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#1a1a1a" },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" translate="no" className={`${notoSansMono.variable} notranslate`} suppressHydrationWarning>
      <head>
        <meta name="google" content="notranslate" />
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){function report(v){try{v.userAgent=String(navigator.userAgent||"").slice(0,300);var x=new XMLHttpRequest();x.open("POST","/api/client-error",true);x.setRequestHeader("Content-Type","application/json");x.send(JSON.stringify(v));}catch(_){}}window.addEventListener("error",function(e){report({type:"error",message:String(e.message||"Script error").slice(0,500),file:String(e.filename||"").slice(0,300),line:e.lineno||0,column:e.colno||0});});window.addEventListener("unhandledrejection",function(e){var r=e.reason;report({type:"rejection",message:String(r&&r.message?r.message:r||"Unhandled rejection").slice(0,500)});});})();`,
          }}
        />
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem("pi-theme");if(t==="dark")document.documentElement.classList.add("dark")}catch(e){}})();`,
          }}
        />
      </head>
      <body translate="no" className="notranslate" style={{ height: "100dvh", display: "flex", flexDirection: "column" }}>
        {children}
        <MobileFullscreenPrompt />
        <MobileDevToolsGuard />
        <AgentationDevTools />
      </body>
    </html>
  );
}
