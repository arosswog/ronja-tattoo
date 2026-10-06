const test = require("node:test");
const assert = require("node:assert/strict");

const { normalizeSettledSendResult, emailTemplates } = require("../lib/email");

const sampleBooking = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Anna Beispiel",
  email: "anna@example.com",
  instagram: "@anna",
  preferredDate: "2026-12-11T13:30:00.000Z",
  placement: "Unterarm",
  size: "10 cm",
  designIdea: "Blume mit Schriftzug",
  depositAmountCents: 3000,
};

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

test("every outgoing mail has a reachable Reply-To and a plain-text part", () => {
  const mails = [
    emailTemplates.customerConfirmationEmail(sampleBooking),
    emailTemplates.ownerNotificationEmail(sampleBooking),
    emailTemplates.depositRequestEmail(sampleBooking, "https://checkout.example/abc"),
    emailTemplates.depositRecoveryEmail(sampleBooking, "https://recover.example/abc"),
    emailTemplates.depositReceivedEmailCustomer(sampleBooking),
    emailTemplates.depositReceivedEmailOwner(sampleBooking),
  ];

  assert.equal(mails.length, 6);
  for (const mail of mails) {
    // The From domain has no MX, so without this every customer reply bounces.
    assert.equal(mail.replyTo, "ronja@rosswog.info");
    assert.ok(mail.from.includes("buchung@rnjatatts.com"));
    assert.ok(typeof mail.text === "string" && mail.text.trim().length > 20, "text part missing");
    assert.ok(mail.html.includes("<p>"), "html part missing");
    assert.ok(mail.subject.length > 0);
  }
});

test("the recovery mail carries the long-lived link, not a 24h one", () => {
  const mail = emailTemplates.depositRecoveryEmail(sampleBooking, "https://recover.example/xyz");

  assert.ok(mail.text.includes("https://recover.example/xyz"));
  assert.ok(mail.html.includes("https://recover.example/xyz"));
  assert.match(mail.text, /30 Tage gültig/);
  assert.ok(!/24 Stunden/.test(mail.text));
});
