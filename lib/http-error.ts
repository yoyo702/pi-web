import { NextResponse } from "next/server";

/**
 * An error that carries the HTTP status it should produce. Throw it for
 * caller mistakes (400/404) and state conflicts (409) so routes don't report
 * them as server failures.
 */
export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

export const badRequest = (message: string) => new HttpError(400, message);
export const notFound = (message: string) => new HttpError(404, message);
export const conflict = (message: string) => new HttpError(409, message);

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** JSON error response: HttpError keeps its status; anything else is a 500. */
export function errorResponse(error: unknown): NextResponse {
  const status = error instanceof HttpError ? error.status : 500;
  if (status >= 500) console.error("[api]", error);
  return NextResponse.json({ error: errorMessage(error) }, { status });
}
