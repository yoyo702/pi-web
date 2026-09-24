import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { HttpError, badRequest, conflict, notFound, errorResponse } = await jiti.import("./http-error.ts");

test("HttpError keeps its status and a clean message", async () => {
  const cases = [[badRequest("bad"), 400], [notFound("missing"), 404], [conflict("busy"), 409], [new HttpError(403, "no"), 403]];
  for (const [error, status] of cases) {
    const response = errorResponse(error);
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error: error.message });
  }
});

test("other errors become 500 without the 'Error: ' prefix", async (t) => {
  t.mock.method(console, "error", () => {});
  const response = errorResponse(new Error("boom"));
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "boom" });
  assert.deepEqual(await errorResponse("plain").json(), { error: "plain" });
});
