import type { NextConfig } from "next";
import { readFileSync } from "fs";
import { networkInterfaces } from "os";
import { join } from "path";

const { version } = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf8")) as { version: string };
const DEFAULT_TURBOPACK_MEMORY_MB = 1536;
const configuredTurbopackMemoryMb = Number(process.env.PI_WEB_TURBOPACK_MEMORY_MB);
const turbopackMemoryMb = Number.isFinite(configuredTurbopackMemoryMb) && configuredTurbopackMemoryMb >= 512
  ? Math.floor(configuredTurbopackMemoryMb)
  : DEFAULT_TURBOPACK_MEMORY_MB;
const localDevOrigins = Object.values(networkInterfaces())
  .flat()
  .filter((entry) => entry && !entry.internal)
  .map((entry) => entry!.address);
const loopbackDevOrigins = ["127.0.0.1", "[::1]"];
const tailscaleDevOrigins = ["**.ts.net"];
let piVersion = "unknown";
try {
  const piPkgPath = join(__dirname, "node_modules/@earendil-works/pi-coding-agent/package.json");
  piVersion = (JSON.parse(readFileSync(piPkgPath, "utf8")) as { version: string }).version;
} catch { /* package not found, use default */ }

const nextConfig: NextConfig = {
  ...(process.env.PI_WEB_NEXT_DIST_DIR ? { distDir: process.env.PI_WEB_NEXT_DIST_DIR } : {}),
  ...(process.env.PI_WEB_E2E === "1" ? { devIndicators: false } : {}),
  experimental: {
    // This app is commonly kept running for days. Bound Turbopack's in-memory
    // task cache so repeated HMR generations cannot grow until V8's heap limit.
    turbopackMemoryLimit: turbopackMemoryMb * 1024 * 1024,
  },
  serverExternalPackages: [
    "undici",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-tui",
    "node-pty",
    "ws",
  ],
  // Next protects its HMR endpoints separately. Allow addresses currently
  // assigned to this machine plus private Tailscale Serve hostnames.
  allowedDevOrigins: [...new Set(["192.168.*.*", ...loopbackDevOrigins, ...localDevOrigins, ...tailscaleDevOrigins])],
  async headers() {
    return [
      {
        source: "/",
        headers: [
          { key: "Cache-Control", value: "private, no-cache, max-age=0, must-revalidate" },
        ],
      },
    ];
  },
  env: {
    NEXT_PUBLIC_APP_VERSION: version,
    NEXT_PUBLIC_PI_VERSION: piVersion,
  },
};

export default nextConfig;
