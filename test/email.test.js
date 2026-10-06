const test = require("node:test");
const assert = require("node:assert/strict");

const { normalizeSettledSendResult } = require("../lib/email");

test("settled email results preserve a successful customer send when another send throws", () => {
  const customer = normalizeSettledSendResult(
    { status: "fulfilled", value: { data: { id: "customer-email-id" }, error: null } },
    "customer@example.com"
  );
  const owner = normalizeSettledSendResult(
    { status: "rejected", reason: new Error("owner mailbox unavailable") },
    "owner@example.com"
  );

  assert.deepEqual(customer, {
    recipient: "customer@example.com",
    providerEmailId: "customer-email-id",
    status: "sent",
    error: null,
  });
  assert.equal(owner.recipient, "owner@example.com");
  assert.equal(owner.providerEmailId, null);
  assert.equal(owner.status, "failed");
  assert.equal(owner.error, "owner mailbox unavailable");
});
