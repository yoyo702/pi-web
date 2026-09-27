export class RequestBodyTooLargeError extends Error {
  constructor() {
    super("Request body exceeds the allowed size");
  }
}

function declaredContentLength(request: Request): number | null {
  const value = request.headers.get("content-length");
  if (!value || !/^\d+$/.test(value)) return null;
  const length = Number(value);
  return Number.isSafeInteger(length) ? length : null;
}

/**
 * Reads the complete wire body, rejecting it once it exceeds `maxBytes`. A
 * declared Content-Length over the cap is rejected before any read; chunked
 * requests (where Content-Length is absent or understated) are still capped
 * by the running total read from the stream. Returns null when the request
 * has no readable body stream.
 */
async function readBodyWithinLimit(request: Request, maxBytes: number): Promise<Uint8Array<ArrayBuffer>[] | null> {
  const declared = declaredContentLength(request);
  if (declared !== null && declared > maxBytes) {
    throw new RequestBodyTooLargeError();
  }

  const reader = request.body?.getReader();
  if (!reader) return null;

  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new RequestBodyTooLargeError();
      }
      size += value.byteLength;
      const chunk = new Uint8Array(value.byteLength);
      chunk.set(value);
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return chunks;
}

/**
 * Parse multipart data only after constraining the complete wire body. This
 * bounds chunked requests too, where Content-Length is unavailable or false.
 */
export async function parseFormDataWithinLimit(request: Request, maxBytes: number): Promise<FormData> {
  const chunks = await readBodyWithinLimit(request, maxBytes);
  if (!chunks) return request.formData();

  const contentType = request.headers.get("content-type");
  const headers = contentType ? { "content-type": contentType } : undefined;
  return new Response(new Blob(chunks), { headers }).formData();
}

/**
 * Parse a JSON body only after constraining the complete wire body, the same
 * way parseFormDataWithinLimit bounds multipart requests.
 */
export async function parseJsonWithinLimit(request: Request, maxBytes: number): Promise<unknown> {
  const chunks = await readBodyWithinLimit(request, maxBytes);
  if (!chunks) return request.json();

  const text = Buffer.concat(chunks).toString("utf-8");
  return JSON.parse(text);
}
