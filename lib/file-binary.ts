import fs from "fs";
import { isBinaryBuffer } from "./file-types";

const BINARY_SNIFF_BYTES = 8000;

/** Reads a small prefix of the file and checks it for a NUL byte. Never
 * throws: a file that can't be opened is treated as "not binary" so the
 * caller's own stat/read calls produce the real error. */
export function isBinaryFile(filePath: string): boolean {
  let fd: number;
  try {
    fd = fs.openSync(filePath, "r");
  } catch {
    return false;
  }
  try {
    const buffer = Buffer.alloc(BINARY_SNIFF_BYTES);
    const bytesRead = fs.readSync(fd, buffer, 0, BINARY_SNIFF_BYTES, 0);
    return isBinaryBuffer(buffer.subarray(0, bytesRead));
  } finally {
    fs.closeSync(fd);
  }
}

/** Given `length` valid bytes at the start of `buffer`, returns the largest
 * length <= `length` that does not split a multi-byte UTF-8 character
 * across the cut. Only ever backs up, never extends, and backs up at most 3
 * bytes (the widest UTF-8 sequence minus its leading byte). Used when a
 * file read stops at an arbitrary byte offset (a truncated preview read),
 * so the decoded tail doesn't turn into a stray U+FFFD replacement
 * character where a multi-byte character was cut in half. */
export function truncateToUtf8Boundary(buffer: Buffer, length: number): number {
  let i = length - 1;
  let continuationBytes = 0;
  while (i >= 0 && continuationBytes < 3 && (buffer[i] & 0xc0) === 0x80) {
    i--;
    continuationBytes++;
  }
  if (i < 0) return 0;
  const leadByte = buffer[i];
  let sequenceLength: number;
  if ((leadByte & 0x80) === 0x00) sequenceLength = 1;
  else if ((leadByte & 0xe0) === 0xc0) sequenceLength = 2;
  else if ((leadByte & 0xf0) === 0xe0) sequenceLength = 3;
  else if ((leadByte & 0xf8) === 0xf0) sequenceLength = 4;
  else sequenceLength = 1; // not a valid lead byte; don't truncate further than necessary
  return i + sequenceLength <= length ? length : i;
}

/** Decodes bytes as UTF-8. `validUtf8` is false when any byte sequence is
 * invalid (e.g. GBK, Shift-JIS or Latin-1 text); `text` is then the lossy
 * U+FFFD-replaced decoding, fine for display but unsafe to save back. */
export function decodeUtf8Text(buffer: Uint8Array): { text: string; validUtf8: boolean } {
  try {
    // ignoreBOM keeps a leading BOM in the text, so saving writes it back.
    return { text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer), validUtf8: true };
  } catch {
    return { text: new TextDecoder("utf-8", { ignoreBOM: true }).decode(buffer), validUtf8: false };
  }
}

/** True when the whole file on disk is valid UTF-8. Streams the file through
 * a fatal decoder so the whole file is never held in memory. Read errors
 * reject, like fs.readFile. */
export async function isUtf8File(filePath: string): Promise<boolean> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const stream = fs.createReadStream(filePath);
  try {
    for await (const chunk of stream) {
      decoder.decode(chunk as Buffer, { stream: true });
    }
    // Flush: a multi-byte sequence left incomplete at EOF is invalid too.
    decoder.decode();
    return true;
  } catch (error) {
    if (error instanceof TypeError) return false;
    throw error;
  } finally {
    stream.destroy();
  }
}
