import type { Metadata } from "next";
import { Noto_Sans_Mono } from "next/font/google";
import "katex/dist/katex.min.css";
import "@xterm/xterm/css/xterm.css";
import "./globals.css";
import { AgentationDevTools } from "@/components/AgentationDevTools";

const notoSansMono = Noto_Sans_Mono({
  subsets: ["latin", "cyrillic"],
  variable: "--font-noto-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Pi Web",
  description: "Pi Web interface for the pi coding agent",
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
            __html: `(function(){function report(v){try{var x=new XMLHttpRequest();x.open("POST","/api/client-error",true);x.setRequestHeader("Content-Type","application/json");x.send(JSON.stringify(v));}catch(_){}}window.addEventListener("error",function(e){report({type:"error",message:String(e.message||"Script error").slice(0,500),file:String(e.filename||"").slice(0,300),line:e.lineno||0,column:e.colno||0});});window.addEventListener("unhandledrejection",function(e){var r=e.reason;report({type:"rejection",message:String(r&&r.message?r.message:r||"Unhandled rejection").slice(0,500)});});})();`,
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
        <AgentationDevTools />
      </body>
    </html>
  );
}
