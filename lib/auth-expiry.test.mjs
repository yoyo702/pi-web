import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { isPossibleAuthExpiry } = await jiti.import("./auth-expiry.ts");
const origin = "https://pi.example:30141";

test("a same-origin API 401 may mean the login expired", () => {
  assert.equal(isPossibleAuthExpiry("/api/sessions", 401, origin), true);
  assert.equal(isPossibleAuthExpiry(`${origin}/api/git/status?cwd=%2Ftmp`, 401, origin), true);
});

test("other statuses, auth endpoints, pages and other origins are ignored", () => {
  assert.equal(isPossibleAuthExpiry("/api/sessions", 403, origin), false);
  assert.equal(isPossibleAuthExpiry("/api/sessions", 500, origin), false);
  assert.equal(isPossibleAuthExpiry("/api/auth/login", 401, origin), false);
  assert.equal(isPossibleAuthExpiry("/login", 401, origin), false);
  assert.equal(isPossibleAuthExpiry("https://api.github.com/api/x", 401, origin), false);
  assert.equal(isPossibleAuthExpiry("http://[bad", 401, origin), false);
});
