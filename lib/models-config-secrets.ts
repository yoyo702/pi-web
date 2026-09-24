/**
 * Keep literal provider credentials from models.json on the server. GET
 * responses replace them with a placeholder; PUT/test requests that still
 * carry the placeholder get the stored value restored.
 *
 * Environment references (`$VAR`, `${VAR}`) and command references (`!cmd`)
 * are configuration rather than secrets, so they stay visible and editable.
 */
export const REDACTED_SECRET = "__pi_web_redacted__";

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLiteralSecret(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.startsWith("$") && !value.startsWith("!");
}

function redactProvider(provider: Json): Json {
  const next: Json = { ...provider };
  if (isLiteralSecret(next.apiKey)) next.apiKey = REDACTED_SECRET;
  if (isRecord(next.headers)) {
    next.headers = Object.fromEntries(Object.entries(next.headers).map(([name, value]) => [name, isLiteralSecret(value) ? REDACTED_SECRET : value]));
  }
  return next;
}

function restoreProvider(provider: Json, stored: Json | undefined): Json {
  const next: Json = { ...provider };
  if (next.apiKey === REDACTED_SECRET) next.apiKey = stored?.apiKey;
  if (isRecord(next.headers)) {
    const storedHeaders = isRecord(stored?.headers) ? stored.headers : {};
    next.headers = Object.fromEntries(Object.entries(next.headers).map(([name, value]) => [name, value === REDACTED_SECRET ? storedHeaders[name] : value]));
  }
  return next;
}

function mapProviders(config: Json, map: (provider: Json, name: string) => Json): Json {
  if (!isRecord(config.providers)) return config;
  return {
    ...config,
    providers: Object.fromEntries(Object.entries(config.providers).map(([name, provider]) => [name, isRecord(provider) ? map(provider, name) : provider])),
  };
}

export function redactModelsConfig(config: Json): Json {
  return mapProviders(config, redactProvider);
}

function storedProvider(stored: Json, name: string): Json | undefined {
  const provider = isRecord(stored.providers) ? stored.providers[name] : undefined;
  return isRecord(provider) ? provider : undefined;
}

export function providerHasRedactedSecret(provider: Json): boolean {
  return provider.apiKey === REDACTED_SECRET
    || (isRecord(provider.headers) && Object.values(provider.headers).includes(REDACTED_SECRET));
}

export function restoreModelsConfigSecrets(incoming: Json, stored: Json): Json {
  return mapProviders(incoming, (provider, name) => restoreProvider(provider, storedProvider(stored, name)));
}

export function restoreProviderSecrets(provider: Json, providerName: string, stored: Json): Json {
  return restoreProvider(provider, storedProvider(stored, providerName));
}
