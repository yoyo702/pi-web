import { networkInterfaces } from "node:os";
import { NextResponse } from "next/server";
import { collectAccessAddresses, type AccessInfo } from "@/lib/access-links";

export const dynamic = "force-dynamic";

export async function GET() {
  const protocol = process.env.PI_WEB_RUNTIME_PROTOCOL === "https" ? "https" : "http";
  const configuredPort = Number(process.env.PI_WEB_RUNTIME_PORT);
  const port = Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65535
    ? configuredPort
    : 30141;
  const listenHost = process.env.PI_WEB_RUNTIME_HOST || "127.0.0.1";
  const result: AccessInfo = {
    protocol,
    port,
    listenHost,
    passwordRequired: Boolean(process.env.PI_WEB_PASSWORD),
    addresses: collectAccessAddresses(networkInterfaces(), { protocol, port, listenHost }),
  };

  return NextResponse.json(result, {
    headers: { "Cache-Control": "private, no-store" },
  });
}
