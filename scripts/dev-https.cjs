#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync, spawn } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const certDir = path.join(root, ".certs");
const cert = path.join(certDir, "pi-web.pem");
const key = path.join(certDir, "pi-web-key.pem");
const authDir = path.join(os.homedir(), ".pi-web");
const passwordFile = path.join(authDir, "dev-password");

function readStoredPassword() {
  try {
    const stat = fs.statSync(passwordFile);
    if ((stat.mode & 0o077) !== 0) fs.chmodSync(passwordFile, 0o600);
    const value = fs.readFileSync(passwordFile, "utf8").trim();
    return value || null;
  } catch { return null; }
}

function developmentPassword() {
  if (process.env.PI_WEB_PASSWORD) return process.env.PI_WEB_PASSWORD;
  const stored = readStoredPassword();
  if (stored) return stored;
  const generated = crypto.randomBytes(18).toString("base64url");
  fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(passwordFile, `${generated}\n`, { mode: 0o600, flag: "wx" });
  console.log(`Generated a persistent TianForge pi development password: ${generated}`);
  console.log(`Stored securely at ${passwordFile}. This message is shown only once.`);
  return generated;
}
const ips = Object.values(os.networkInterfaces()).flat().filter((entry) => entry && entry.family === "IPv4" && !entry.internal).map((entry) => entry.address);
if (!ips.length) throw new Error("No LAN IPv4 address was found");
fs.mkdirSync(certDir, { recursive: true, mode: 0o700 });
function certificateCoversCurrentAddresses() {
  if (!fs.existsSync(cert) || !fs.existsSync(key)) return false;
  const inspected = spawnSync("openssl", ["x509", "-in", cert, "-noout", "-checkend", "86400", "-ext", "subjectAltName"], { encoding: "utf8" });
  if (inspected.status !== 0) return false;
  const details = `${inspected.stdout || ""}\n${inspected.stderr || ""}`;
  return ips.every((ip) => details.includes(`IP Address:${ip}`));
}
if (!certificateCoversCurrentAddresses()) {
  const install = spawnSync("mkcert", ["-install"], { stdio: "inherit" });
  if (install.status !== 0) throw new Error("mkcert -install failed");
  const generated = spawnSync("mkcert", ["-cert-file", cert, "-key-file", key, "localhost", "127.0.0.1", "::1", ...ips], { stdio: "inherit" });
  if (generated.status !== 0) throw new Error("mkcert certificate generation failed");
  fs.chmodSync(key, 0o600);
}
const password = developmentPassword();
console.log("TianForge pi LAN addresses:");
for (const ip of ips) console.log(`  https://${ip}:30141`);
const child = spawn(process.execPath, ["server/pi-web-server.js", "dev", "-H", "0.0.0.0", "-p", "30141"], { cwd: root, stdio: "inherit", env: { ...process.env, PI_WEB_PASSWORD: password, PI_WEB_HTTPS_CERT: cert, PI_WEB_HTTPS_KEY: key } });
child.on("exit", (code) => process.exit(code ?? 0));
