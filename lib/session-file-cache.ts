import { closeSync, fstatSync, openSync, readSync } from "fs";
import { CURRENT_SESSION_VERSION, SessionManager } from "@earendil-works/pi-coding-agent";

/**
 * Read-only session loading for request handlers.
 *
 * Parsing a session file is synchronous and runs on the one server process;
 * a long session (tens of MB) blocks every chat stream and terminal for
 * ~100 ms, and the browser reloads the open session after every turn. Pi
 * session files are append-only, so keep each file's parsed entries and, on
 * the next read, parse only the bytes appended since. Any sign the file was
 * rewritten (shrunk, replaced, prefix or last-read bytes changed) falls back
 * to a full parse. Files missing or on an older format version go through
 * the SDK loader. Callers must not mutate the returned entries.
 */

const MAX_FILES = 6;
// File bytes; parsed objects take roughly twice that on the heap.
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const CHECK_BYTES = 4096;
const READ_CHUNK = 1024 * 1024;
const NEWLINE = 0x0a;

interface CachedSessionFile {
  ino: number;
  size: number;
  /** Bytes parsed so far; always just past a newline. */
  offset: number;
  entries: unknown[];
  head: Buffer;
  tail: Buffer;
}

const globalCache = globalThis as typeof globalThis & { __piWebSessionFileCache?: Map<string, CachedSessionFile> };

function sessionFileCache(): Map<string, CachedSessionFile> {
  if (!globalCache.__piWebSessionFileCache) globalCache.__piWebSessionFileCache = new Map();
  return globalCache.__piWebSessionFileCache;
}

function readBytes(fd: number, position: number, length: number): Buffer {
  const buffer = Buffer.allocUnsafe(length);
  let read = 0;
  while (read < length) {
    const bytes = readSync(fd, buffer, read, length - read, position + read);
    if (bytes === 0) break;
    read += bytes;
  }
  return buffer.subarray(0, read);
}

function parseLine(line: Buffer): unknown {
  const text = line.toString("utf8");
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined; // skip malformed lines, like the SDK loader
  }
}

/** Parse complete lines in [start, end); returns the new offset and any unterminated trailing bytes. */
function parseRange(fd: number, start: number, end: number, entries: unknown[]): { offset: number; trailing: Buffer } {
  // `pending` holds the unterminated bytes starting at `offset`. Chunks without
  // a newline are only collected, so a very long line is not re-scanned.
  let offset = start;
  let pending: Buffer[] = [];
  let position = start;
  while (position < end) {
    const chunk = readBytes(fd, position, Math.min(READ_CHUNK, end - position));
    if (chunk.length === 0) break;
    position += chunk.length;
    const firstNewline = chunk.indexOf(NEWLINE);
    if (firstNewline === -1) {
      pending.push(chunk);
      continue;
    }
    const data = pending.length ? Buffer.concat([...pending, chunk]) : chunk;
    let lineStart = 0;
    let newline = data.length - chunk.length + firstNewline;
    while (newline !== -1) {
      const entry = parseLine(data.subarray(lineStart, newline));
      if (entry !== undefined) entries.push(entry);
      lineStart = newline + 1;
      newline = data.indexOf(NEWLINE, lineStart);
    }
    offset += lineStart;
    pending = lineStart < data.length ? [Buffer.from(data.subarray(lineStart))] : [];
  }
  return { offset, trailing: Buffer.concat(pending) };
}

function sameBytes(fd: number, position: number, expected: Buffer): boolean {
  return expected.length === 0 || readBytes(fd, position, expected.length).equals(expected);
}

function evict(cache: Map<string, CachedSessionFile>): void {
  let total = 0;
  for (const entry of cache.values()) total += entry.size;
  for (const [key, entry] of cache) {
    if (cache.size <= MAX_FILES && total <= MAX_TOTAL_BYTES) break;
    cache.delete(key);
    total -= entry.size;
  }
}

/**
 * All parsed entries of a session file, header first, or null when the file
 * is not a valid session (callers fall back to the SDK loader).
 */
export function readSessionFileEntries(filePath: string): unknown[] | null {
  const cache = sessionFileCache();
  const fd = openSync(filePath, "r");
  try {
    const stat = fstatSync(fd);
    let cached = cache.get(filePath);
    if (cached && (
      cached.ino !== stat.ino
      || stat.size < cached.offset
      || !sameBytes(fd, 0, cached.head)
      || !sameBytes(fd, cached.offset - cached.tail.length, cached.tail)
    )) {
      cached = undefined;
    }
    if (!cached) {
      cached = { ino: stat.ino, size: 0, offset: 0, entries: [], head: Buffer.alloc(0), tail: Buffer.alloc(0) };
    }

    // Read everything first and commit only on success, so a failed read
    // cannot leave entries appended without advancing the offset.
    const appended: unknown[] = [];
    const { offset, trailing } = parseRange(fd, cached.offset, stat.size, appended);
    const head = cached.head.length < CHECK_BYTES ? readBytes(fd, 0, Math.min(CHECK_BYTES, offset)) : cached.head;
    const tail = readBytes(fd, offset - Math.min(CHECK_BYTES, offset), Math.min(CHECK_BYTES, offset));
    for (const entry of appended) cached.entries.push(entry);
    cached.offset = offset;
    cached.size = stat.size;
    cached.head = head;
    cached.tail = tail;

    // Older formats are migrated by the SDK loader, which also rewrites the
    // file so migrated ids stay stable; let it handle those.
    const header = cached.entries[0] as { type?: unknown; id?: unknown; version?: unknown } | undefined;
    if (!header || header.type !== "session" || typeof header.id !== "string"
      || typeof header.version !== "number" || header.version < CURRENT_SESSION_VERSION) {
      cache.delete(filePath);
      return null;
    }
    cache.delete(filePath);
    cache.set(filePath, cached);
    evict(cache);

    // An unterminated last line is either mid-write or a file without a final
    // newline; include it when it parses (as the SDK does) but keep it out of
    // the cache so the next read re-parses it once complete.
    const last = trailing.length ? parseLine(trailing) : undefined;
    return last === undefined ? cached.entries : [...cached.entries, last];
  } finally {
    closeSync(fd);
  }
}

/** A read-only SessionManager over the cached entries. Never append through it. */
export function openSessionForRead(filePath: string): SessionManager {
  let entries: unknown[] | null;
  try {
    entries = readSessionFileEntries(filePath);
  } catch (error) {
    // A new session's file is only created with its first assistant message;
    // the SDK loader returns an empty session for it without writing.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    entries = null;
  }
  if (!entries) return SessionManager.open(filePath);
  const header = entries[0] as { cwd?: string };
  return SessionManager.inMemory(header.cwd || process.cwd(), undefined, entries.slice() as never);
}

export function invalidateSessionFileCache(filePath?: string): void {
  if (filePath) sessionFileCache().delete(filePath);
  else sessionFileCache().clear();
}
