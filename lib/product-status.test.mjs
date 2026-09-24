import test from "node:test";
import assert from "node:assert/strict";
import { PRODUCT_STATUS, PRODUCT_STATUS_GUIDE, getProductStatus } from "./product-status.ts";

test("the product status guide only references registered statuses", () => {
  assert.equal(new Set(PRODUCT_STATUS_GUIDE).size, PRODUCT_STATUS_GUIDE.length);
  for (const id of PRODUCT_STATUS_GUIDE) assert.equal(getProductStatus(id).id, id);
});

test("every product status has accessible copy and a visual color", () => {
  for (const [id, status] of Object.entries(PRODUCT_STATUS)) {
    assert.equal(status.id, id);
    assert.ok(status.label.trim());
    assert.ok(status.description.trim());
    assert.ok(status.color.trim());
  }
});
