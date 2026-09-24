import { NextResponse } from "next/server";
import { chmodSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { invalidateModelsCache } from "@/lib/models-cache";
import { normalizeModelCompat } from "@/lib/model-compat";
import { getModelsPath, readModelsJson } from "@/lib/models-config-file";
import { redactModelsConfig, restoreModelsConfigSecrets } from "@/lib/models-config-secrets";

export const dynamic = "force-dynamic";

function writeModelsJson(data: Record<string, unknown>): void {
  const path = getModelsPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // models.json holds provider API keys; keep it private to the owner.
  writeFileSync(path, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}

export async function GET() {
  return NextResponse.json(redactModelsConfig(readModelsJson()), { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(req: Request) {
  try {
    const body = restoreModelsConfigSecrets(await req.json() as Record<string, unknown>, readModelsJson());
    if (body.providers && typeof body.providers === "object") {
      for (const provider of Object.values(body.providers)) {
        if (!provider || typeof provider !== "object" || !Array.isArray(provider.models)) continue;
        provider.models = provider.models.map((model: { id: string }) => normalizeModelCompat(model, provider.api));
      }
    }
    writeModelsJson(body);
    invalidateModelsCache();
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
