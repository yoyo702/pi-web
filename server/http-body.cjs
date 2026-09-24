"use strict";

/**
 * Read a request body up to `limit` bytes. Oversized bodies are rejected
 * without buffering the remainder, so unauthenticated endpoints such as
 * /login cannot be used to exhaust memory.
 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers?.["content-length"]);
    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      reject(new Error("request too large"));
      return;
    }
    const chunks = [];
    let size = 0;
    const onData = (chunk) => {
      size += chunk.length;
      if (size > limit) {
        req.off("data", onData);
        req.off("end", onEnd);
        // Keep draining so the caller can still write an error response, but
        // discard everything instead of accumulating it.
        req.resume();
        reject(new Error("request too large"));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => resolve(Buffer.concat(chunks).toString("utf8"));
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", reject);
  });
}

async function readJsonBody(req, limit) {
  const body = await readBody(req, limit);
  try { return JSON.parse(body); } catch { throw new Error("invalid request body"); }
}

async function readFormBody(req, limit) {
  const body = await readBody(req, limit);
  return Object.fromEntries(new URLSearchParams(body));
}

module.exports = { readBody, readJsonBody, readFormBody };
