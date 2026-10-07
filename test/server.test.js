const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const { createApp } = require("../server");
const { query, closePool } = require("../lib/db");
const { runMigrations } = require("../lib/migrate");
const bookingStore = require("../lib/store/bookings");

// Hard guard against ever repeating the 2026-08-18 incident where this
// suite's TRUNCATE ran against the production database because the test
// script loaded the wrong env file. Every test database name in this
// project must contain "test" — refuse to wipe anything else.
async function assertRunningAgainstTestDatabase() {
  const { rows } = await query("SELECT current_database() AS name");
  const name = rows[0].name;
  if (!name.includes("test")) {
    throw new Error(
      `Refusing to run destructive tests against database "${name}" — ` +
        `it doesn't look like a test database. Check .env.test.local.`
    );
  }
}

async function resetData() {
  await assertRunningAgainstTestDatabase();

  // TRUNCATE ... RESTART IDENTITY CASCADE is the Postgres equivalent of the
  // old writeJson(file, []) reset — wipes every row and any dependent data,
  // fresh for each test. gallery_entries is repopulated by re-running the
  // (idempotent) seed migration's INSERT afterwards.
  await query(
    "TRUNCATE bookings, gallery_entries, sessions, slots RESTART IDENTITY CASCADE"
  );
  await query(
    `UPDATE admin_account
     SET configured = false, password_hash = '', salt = '', created_at = NULL
     WHERE id = 1`
  );
  await runMigrations(); // no-op for already-applied files, re-seeds gallery_entries
}

async function withServer(run, appOptions = {}) {
  await resetData();
  const app = createApp(appOptions);
  const server = http.createServer(app);

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    await run(baseUrl);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
    await resetData();
  }
}

async function setupAndLogin(baseUrl) {
  await fetch(`${baseUrl}/api/admin/setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "RonjaSecure123" }),
  });
  const loginResponse = await fetch(`${baseUrl}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "RonjaSecure123" }),
  });
  return loginResponse.headers.get("set-cookie");
}

let slotCounter = 0;

// Every call gets a distinct start time (slotCounter) so tests that create
// multiple slots never collide with the active-start-time unique index.
async function createOpenSlot(baseUrl, cookie, overrides = {}) {
  slotCounter += 1;
  const day = String(10 + slotCounter).padStart(2, "0");
  const response = await fetch(`${baseUrl}/api/admin/slots`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      startsAt: `2026-12-${day}T10:00:00.000Z`,
      endsAt: `2026-12-${day}T13:00:00.000Z`,
      label: "Test Slot",
      depositAmount: "20",
      ...overrides,
    }),
  });
  return response.json();
}

function bookingPayload(slotId, overrides = {}) {
  return {
    slotId,
    name: "Test User",
    email: "test@example.com",
    phone: "@test",
    placement: "Unterarm",
    size: "10 cm",
    designIdea:
      "Fine-line floral concept with ornamental details for endpoint verification.",
    ...overrides,
  };
}

test("gallery endpoint returns seeded tattoo artworks", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/gallery`);
    assert.equal(response.status, 200);

    const gallery = await response.json();
    assert.equal(gallery.length, 3);
    assert.equal(gallery[0].title, "Celestial Script");
  });
});

test("admin can save a draft slot that stays private until it is published", async () => {
  await withServer(async (baseUrl) => {
    const cookie = await setupAndLogin(baseUrl);
    const draftResponse = await fetch(`${baseUrl}/api/admin/slots`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        startsAt: "2027-01-12T10:00:00.000Z",
        endsAt: "2027-01-12T13:00:00.000Z",
        label: "Entwurfspaket",
        depositAmount: "25",
        status: "draft",
      }),
    });

    assert.equal(draftResponse.status, 201);
    const draft = await draftResponse.json();
    assert.equal(draft.status, "draft");
    assert.deepEqual(await (await fetch(`${baseUrl}/api/slots`)).json(), []);

    const adminSlots = await (
      await fetch(`${baseUrl}/api/admin/slots`, { headers: { Cookie: cookie } })
    ).json();
    assert.equal(adminSlots.length, 1);
    assert.equal(adminSlots[0].status, "draft");

    const publish = await fetch(`${baseUrl}/api/admin/slots/${draft.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ status: "open" }),
    });
    assert.equal(publish.status, 200);
    assert.equal((await publish.json()).status, "open");

    const publicSlots = await (await fetch(`${baseUrl}/api/slots`)).json();
    assert.equal(publicSlots.length, 1);
    assert.equal(publicSlots[0].id, draft.id);
  });
});


test("admin can edit a saved draft without publishing it", async () => {
  await withServer(async (baseUrl) => {
    const cookie = await setupAndLogin(baseUrl);
    const draftResponse = await fetch(`${baseUrl}/api/admin/slots`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        startsAt: "2027-01-13T10:00:00.000Z",
        endsAt: "2027-01-13T13:00:00.000Z",
        label: "Alter Entwurf",
        depositAmount: "25",
        status: "draft",
      }),
    });
    const draft = await draftResponse.json();

    const edit = await fetch(`${baseUrl}/api/admin/slots/${draft.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        startsAt: "2027-01-20T14:30:00.000Z",
        endsAt: "2027-01-20T16:30:00.000Z",
        label: "Geänderter Entwurf",
        depositAmount: "30",
      }),
    });

    assert.equal(edit.status, 200);
    const updated = await edit.json();
    assert.equal(updated.startsAt, "2027-01-20T14:30:00.000Z");
    assert.equal(updated.endsAt, "2027-01-20T16:30:00.000Z");
    assert.equal(updated.label, "Geänderter Entwurf");
    assert.equal(updated.depositAmountCents, 3000);
    assert.equal(updated.status, "draft");
    assert.deepEqual(await (await fetch(`${baseUrl}/api/slots`)).json(), []);
  });
});


test("admin cannot edit a slot after it was published", async () => {
  await withServer(async (baseUrl) => {
    const cookie = await setupAndLogin(baseUrl);
    const slot = await createOpenSlot(baseUrl, cookie);

    const edit = await fetch(`${baseUrl}/api/admin/slots/${slot.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        startsAt: "2027-02-20T14:30:00.000Z",
        endsAt: "2027-02-20T16:30:00.000Z",
        label: "Darf nicht geändert werden",
        depositAmount: "30",
      }),
    });

    assert.equal(edit.status, 409);
    assert.deepEqual(await edit.json(), {
      error: "Nur gespeicherte Entwürfe können bearbeitet werden.",
    });
  });
});


test("booking waits for email submission and exposes the customer delivery status to admin", async () => {
  let sendFinished = false;
  const fakeEmailService = {
    async notifyBookingRequest() {
      await new Promise((resolve) => setTimeout(resolve, 10));
      sendFinished = true;
      return {
        customer: { providerEmailId: "email-customer-1", status: "sent", error: null },
        owner: { providerEmailId: "email-owner-1", status: "sent", error: null },
      };
    },
  };

  await withServer(async (baseUrl) => {
    const cookie = await setupAndLogin(baseUrl);
    const slot = await createOpenSlot(baseUrl, cookie);
    const response = await fetch(`${baseUrl}/api/bookings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bookingPayload(slot.id)),
    });

    assert.equal(response.status, 201);
    assert.equal(sendFinished, true);

    const bookings = await (
      await fetch(`${baseUrl}/api/admin/bookings`, { headers: { Cookie: cookie } })
    ).json();
    assert.equal(bookings[0].emailDelivery.status, "sent");
    assert.equal(bookings[0].emailDelivery.attemptCount, 1);
    assert.equal(bookings[0].emailDelivery.error, null);
    assert.equal("providerEmailId" in bookings[0].emailDelivery, false);
  }, { emailService: fakeEmailService });
});


test("admin can resend a failed customer confirmation", async () => {
  let resendCalls = 0;
  const fakeEmailService = {
    async notifyBookingRequest() {
      return {
        customer: { providerEmailId: null, status: "failed", error: "mailbox rejected" },
        owner: { providerEmailId: "email-owner-2", status: "sent", error: null },
      };
    },
    async sendCustomerConfirmation() {
      resendCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { providerEmailId: "email-customer-retry", status: "sent", error: null };
    },
  };

  await withServer(async (baseUrl) => {
    const cookie = await setupAndLogin(baseUrl);
    const slot = await createOpenSlot(baseUrl, cookie);
    await fetch(`${baseUrl}/api/bookings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bookingPayload(slot.id)),
    });
    const before = await (
      await fetch(`${baseUrl}/api/admin/bookings`, { headers: { Cookie: cookie } })
    ).json();
    assert.equal(before[0].emailDelivery.status, "failed");

    const retryUrl = `${baseUrl}/api/admin/bookings/${before[0].id}/resend-confirmation`;
    const [retry, concurrentRetry] = await Promise.all([
      fetch(retryUrl, { method: "POST", headers: { Cookie: cookie } }),
      fetch(retryUrl, { method: "POST", headers: { Cookie: cookie } }),
    ]);
    const responsesByStatus = new Map([
      [retry.status, retry],
      [concurrentRetry.status, concurrentRetry],
    ]);
    assert.deepEqual([...responsesByStatus.keys()].sort(), [200, 409]);
    const retryPayload = await responsesByStatus.get(200).json();
    assert.equal(retryPayload.message, "Buchungsbestätigung erneut an die Kundin gesendet.");
    assert.equal(retryPayload.emailDelivery.status, "sent");
    assert.equal(retryPayload.emailDelivery.attemptCount, 2);
    assert.equal(retryPayload.emailDelivery.error, null);
    assert.match(retryPayload.emailDelivery.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(resendCalls, 1);

    const after = await (
      await fetch(`${baseUrl}/api/admin/bookings`, { headers: { Cookie: cookie } })
    ).json();
    assert.equal(after[0].emailDelivery.status, "sent");
    assert.equal(after[0].emailDelivery.attemptCount, 2);
  }, { emailService: fakeEmailService });
});


test("verified Resend webhook updates the stored delivery status", async () => {
  const fakeEmailService = {
    async notifyBookingRequest() {
      return {
        customer: { providerEmailId: "email-customer-webhook", status: "sent", error: null },
        owner: { providerEmailId: "email-owner-webhook", status: "sent", error: null },
      };
    },
    verifyWebhook({ payload, headers, webhookSecret }) {
      assert.equal(headers.id, "webhook-message-1");
      assert.equal(webhookSecret, "test-webhook-secret");
      return JSON.parse(payload);
    },
  };

  const previousSecret = process.env.RESEND_WEBHOOK_SECRET;
  process.env.RESEND_WEBHOOK_SECRET = "test-webhook-secret";
  try {
    await withServer(async (baseUrl) => {
      const cookie = await setupAndLogin(baseUrl);
      const slot = await createOpenSlot(baseUrl, cookie);
      await fetch(`${baseUrl}/api/bookings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bookingPayload(slot.id)),
      });

      const webhook = await fetch(`${baseUrl}/api/webhooks/resend`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "svix-id": "webhook-message-1",
          "svix-timestamp": "1791150000",
          "svix-signature": "v1,test",
        },
        body: JSON.stringify({
          type: "email.delivered",
          created_at: "2026-10-04T22:00:00.000Z",
          data: { email_id: "email-customer-webhook" },
        }),
      });
      assert.equal(webhook.status, 200);
      assert.deepEqual(await webhook.json(), { received: true });

      const lateFailure = await fetch(`${baseUrl}/api/webhooks/resend`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "svix-id": "webhook-message-1",
          "svix-timestamp": "1791150001",
          "svix-signature": "v1,test",
        },
        body: JSON.stringify({
          type: "email.failed",
          created_at: "2026-10-04T21:59:59.000Z",
          data: {
            email_id: "email-customer-webhook",
            failed: { reason: "late stale failure" },
          },
        }),
      });
      assert.equal(lateFailure.status, 200);

      const bookings = await (
        await fetch(`${baseUrl}/api/admin/bookings`, { headers: { Cookie: cookie } })
      ).json();
      assert.equal(bookings[0].emailDelivery.status, "delivered");
    }, { emailService: fakeEmailService });
  } finally {
    if (previousSecret === undefined) delete process.env.RESEND_WEBHOOK_SECRET;
    else process.env.RESEND_WEBHOOK_SECRET = previousSecret;
  }
});


test("booking requests against an open slot are accepted and stored as pending", async () => {
  await withServer(async (baseUrl) => {
    const cookie = await setupAndLogin(baseUrl);
    const slot = await createOpenSlot(baseUrl, cookie);

    const response = await fetch(`${baseUrl}/api/bookings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bookingPayload(slot.id)),
    });

    assert.equal(response.status, 201);

    const savedBookings = await bookingStore.listBookings();
    assert.equal(savedBookings.length, 1);
    assert.equal(savedBookings[0].status, "pending");
    assert.equal(savedBookings[0].slotId, slot.id);

    // Booking a slot takes it off the public list immediately.
    const publicSlots = await (await fetch(`${baseUrl}/api/slots`)).json();
    assert.equal(publicSlots.length, 0);
  });
});

test("booking a slot that is not open is rejected", async () => {
  await withServer(async (baseUrl) => {
    const cookie = await setupAndLogin(baseUrl);
    const slot = await createOpenSlot(baseUrl, cookie);

    const first = await fetch(`${baseUrl}/api/bookings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bookingPayload(slot.id)),
    });
    assert.equal(first.status, 201);

    const second = await fetch(`${baseUrl}/api/bookings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bookingPayload(slot.id, { email: "second@example.com" })),
    });
    assert.equal(second.status, 409);
  });
});

test("two concurrent booking requests for the same slot: exactly one succeeds", async () => {
  await withServer(async (baseUrl) => {
    const cookie = await setupAndLogin(baseUrl);
    const slot = await createOpenSlot(baseUrl, cookie);

    const [first, second] = await Promise.all([
      fetch(`${baseUrl}/api/bookings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bookingPayload(slot.id, { email: "racer-a@example.com" })),
      }),
      fetch(`${baseUrl}/api/bookings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bookingPayload(slot.id, { email: "racer-b@example.com" })),
      }),
    ]);

    const statuses = [first.status, second.status].sort();
    assert.deepEqual(statuses, [201, 409]);

    const bookings = await bookingStore.listBookings();
    assert.equal(bookings.length, 1);
  });
});

test("admin can be configured, logged in, and read bookings", async () => {
  await withServer(async (baseUrl) => {
    const cookie = await setupAndLogin(baseUrl);
    const slot = await createOpenSlot(baseUrl, cookie);

    const bookingResponse = await fetch(`${baseUrl}/api/bookings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bookingPayload(slot.id, { email: "booking@example.com" })),
    });
    assert.equal(bookingResponse.status, 201);

    const bookingsResponse = await fetch(`${baseUrl}/api/admin/bookings`, {
      headers: { Cookie: cookie },
    });
    assert.equal(bookingsResponse.status, 200);

    const bookings = await bookingsResponse.json();
    assert.equal(bookings.length, 1);
    assert.equal(bookings[0].email, "booking@example.com");
  });
});

test("admin can approve a pending booking", async () => {
  await withServer(async (baseUrl) => {
    const cookie = await setupAndLogin(baseUrl);
    const slot = await createOpenSlot(baseUrl, cookie);

    await fetch(`${baseUrl}/api/bookings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bookingPayload(slot.id, { email: "approve@example.com" })),
    });

    const [{ id }] = await bookingStore.listBookings();

    const patchResponse = await fetch(`${baseUrl}/api/admin/bookings/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ status: "approved" }),
    });
    assert.equal(patchResponse.status, 200);

    const [updated] = await bookingStore.listBookings();
    assert.equal(updated.status, "approved");
    assert.ok(updated.reviewedAt);
  });
});

test("rejecting a booking releases its slot back to the public list", async () => {
  await withServer(async (baseUrl) => {
    const cookie = await setupAndLogin(baseUrl);
    const slot = await createOpenSlot(baseUrl, cookie);

    await fetch(`${baseUrl}/api/bookings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bookingPayload(slot.id, { email: "reject@example.com" })),
    });
    const [{ id }] = await bookingStore.listBookings();

    await fetch(`${baseUrl}/api/admin/bookings/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ status: "rejected" }),
    });

    const publicSlots = await (await fetch(`${baseUrl}/api/slots`)).json();
    assert.equal(publicSlots.length, 1);
    assert.equal(publicSlots[0].id, slot.id);
  });
});

test("cancelling an approved booking releases its slot", async () => {
  await withServer(async (baseUrl) => {
    const cookie = await setupAndLogin(baseUrl);
    const slot = await createOpenSlot(baseUrl, cookie);

    await fetch(`${baseUrl}/api/bookings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bookingPayload(slot.id, { email: "cancel@example.com" })),
    });
    const [{ id }] = await bookingStore.listBookings();

    await fetch(`${baseUrl}/api/admin/bookings/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ status: "approved" }),
    });
    const cancelResponse = await fetch(`${baseUrl}/api/admin/bookings/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ status: "cancelled" }),
    });
    assert.equal(cancelResponse.status, 200);

    const publicSlots = await (await fetch(`${baseUrl}/api/slots`)).json();
    assert.equal(publicSlots.length, 1);
  });
});

test("an expired deposit link keeps the appointment and its slot", async () => {
  await withServer(async (baseUrl) => {
    const cookie = await setupAndLogin(baseUrl);
    const slot = await createOpenSlot(baseUrl, cookie);

    await fetch(`${baseUrl}/api/bookings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bookingPayload(slot.id, { email: "expired-link@example.com" })),
    });
    const [{ id }] = await bookingStore.listBookings();
    await fetch(`${baseUrl}/api/admin/bookings/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ status: "approved" }),
    });

    const expired = await bookingStore.markDepositExpired(id, "https://recover.example/long-lived");

    assert.equal(expired.status, "approved", "the appointment must survive an expired link");
    assert.equal(expired.depositStatus, "expired");
    assert.equal(expired.stripeRecoveryUrl, "https://recover.example/long-lived");

    // The slot must not be offered to other customers again.
    const publicSlots = await (await fetch(`${baseUrl}/api/slots`)).json();
    assert.equal(publicSlots.length, 0);
  });
});

test("approving a booking reserves its slot again", async () => {
  await withServer(async (baseUrl) => {
    const cookie = await setupAndLogin(baseUrl);
    const slot = await createOpenSlot(baseUrl, cookie);

    await fetch(`${baseUrl}/api/bookings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bookingPayload(slot.id, { email: "reapprove@example.com" })),
    });
    const [{ id }] = await bookingStore.listBookings();

    await fetch(`${baseUrl}/api/admin/bookings/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ status: "rejected" }),
    });
    assert.equal((await (await fetch(`${baseUrl}/api/slots`)).json()).length, 1);

    await fetch(`${baseUrl}/api/admin/bookings/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ status: "approved" }),
    });

    const publicSlots = await (await fetch(`${baseUrl}/api/slots`)).json();
    assert.equal(publicSlots.length, 0, "an approved booking must hold its slot");
  });
});

test("resending a recovery link without a stored link is refused", async () => {
  await withServer(async (baseUrl) => {
    const cookie = await setupAndLogin(baseUrl);
    const slot = await createOpenSlot(baseUrl, cookie);

    await fetch(`${baseUrl}/api/bookings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bookingPayload(slot.id, { email: "no-recovery@example.com" })),
    });
    const [{ id }] = await bookingStore.listBookings();
    await fetch(`${baseUrl}/api/admin/bookings/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ status: "approved" }),
    });

    const response = await fetch(`${baseUrl}/api/admin/bookings/${id}/resend-recovery`, {
      method: "POST",
      headers: { Cookie: cookie },
    });

    assert.equal(response.status, 409);
  });
});

test("a free appointment is deleted for good", async () => {
  await withServer(async (baseUrl) => {
    const cookie = await setupAndLogin(baseUrl);
    const slot = await createOpenSlot(baseUrl, cookie);
    const adminHeaders = { "Content-Type": "application/json", Cookie: cookie };

    const unconfirmed = await fetch(`${baseUrl}/api/admin/slots/${slot.id}`, {
      method: "DELETE",
      headers: adminHeaders,
      body: JSON.stringify({}),
    });
    assert.equal(unconfirmed.status, 409);

    const response = await fetch(`${baseUrl}/api/admin/slots/${slot.id}`, {
      method: "DELETE",
      headers: adminHeaders,
      body: JSON.stringify({ confirmation: "DELETE" }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).archived, false);

    assert.equal(
      (await (await fetch(`${baseUrl}/api/admin/slots`, { headers: { Cookie: cookie } })).json()).length,
      0
    );
    assert.equal((await (await fetch(`${baseUrl}/api/slots`)).json()).length, 0);

    // Nothing to preserve here, so the row is really gone.
    const { rows } = await query("SELECT count(*)::int AS n FROM slots WHERE id = $1", [slot.id]);
    assert.equal(rows[0].n, 0);
  });
});

test("a booked appointment needs the second confirmation and keeps its payment record", async () => {
  await withServer(async (baseUrl) => {
    const cookie = await setupAndLogin(baseUrl);
    const slot = await createOpenSlot(baseUrl, cookie);
    const adminHeaders = { "Content-Type": "application/json", Cookie: cookie };

    await fetch(`${baseUrl}/api/bookings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bookingPayload(slot.id, { email: "paid-delete@example.com" })),
    });
    const [{ id }] = await bookingStore.listBookings();
    await bookingStore.updateDepositStatus(id, {
      depositStatus: "paid",
      stripePaymentIntentId: "pi_test_delete",
    });

    const firstAttempt = await fetch(`${baseUrl}/api/admin/slots/${slot.id}`, {
      method: "DELETE",
      headers: adminHeaders,
      body: JSON.stringify({}),
    });
    assert.equal(firstAttempt.status, 409);
    const impact = await firstAttempt.json();
    assert.equal(impact.requiresDoubleConfirmation, true);
    assert.equal(impact.depositPaid, true);

    const second = await fetch(`${baseUrl}/api/admin/slots/${slot.id}`, {
      method: "DELETE",
      headers: adminHeaders,
      body: JSON.stringify({ confirmation: "DELETE_BOOKED" }),
    });
    assert.equal(second.status, 200);
    assert.equal((await second.json()).archived, true);

    // Gone from Ronja's appointment list and from her booking list.
    assert.equal(
      (await (await fetch(`${baseUrl}/api/admin/slots`, { headers: { Cookie: cookie } })).json()).length,
      0
    );
    assert.equal(
      (await (await fetch(`${baseUrl}/api/admin/bookings`, { headers: { Cookie: cookie } })).json()).length,
      0
    );

    // The money record survives.
    const { rows } = await query(
      "SELECT deposit_status, stripe_payment_intent_id, archived_at FROM bookings WHERE id = $1",
      [id]
    );
    assert.equal(rows[0].deposit_status, "paid");
    assert.equal(rows[0].stripe_payment_intent_id, "pi_test_delete");
    assert.ok(rows[0].archived_at, "booking must be archived, not destroyed");
  });
});

test("a deleted appointment can no longer be booked", async () => {
  await withServer(async (baseUrl) => {
    const cookie = await setupAndLogin(baseUrl);
    const slot = await createOpenSlot(baseUrl, cookie);
    const adminHeaders = { "Content-Type": "application/json", Cookie: cookie };

    await fetch(`${baseUrl}/api/bookings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bookingPayload(slot.id, { email: "archived-slot@example.com" })),
    });

    await fetch(`${baseUrl}/api/admin/slots/${slot.id}`, {
      method: "DELETE",
      headers: adminHeaders,
      body: JSON.stringify({ confirmation: "DELETE_BOOKED" }),
    });

    const staleBooking = await fetch(`${baseUrl}/api/bookings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bookingPayload(slot.id, { email: "stale@example.com" })),
    });

    assert.equal(staleBooking.status, 404, "a stale slot id must not be bookable");
  });
});

test("admin can create a slot and it appears on the public slots endpoint", async () => {
  await withServer(async (baseUrl) => {
    const cookie = await setupAndLogin(baseUrl);

    const createResponse = await fetch(`${baseUrl}/api/admin/slots`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        startsAt: "2026-10-01T10:00:00.000Z",
        endsAt: "2026-10-01T13:00:00.000Z",
        label: "Fine-Line Session",
        depositAmount: "20.50",
      }),
    });
    assert.equal(createResponse.status, 201);
    const created = await createResponse.json();
    assert.equal(created.status, "open");
    assert.equal(created.depositAmountCents, 2050);

    const publicResponse = await fetch(`${baseUrl}/api/slots`);
    const publicSlots = await publicResponse.json();
    assert.equal(publicSlots.length, 1);
    assert.equal(publicSlots[0].id, created.id);
  });
});

test("creating a slot at an already-active start time is rejected", async () => {
  await withServer(async (baseUrl) => {
    const cookie = await setupAndLogin(baseUrl);
    const payload = {
      startsAt: "2026-10-02T10:00:00.000Z",
      endsAt: "2026-10-02T13:00:00.000Z",
      depositAmount: "20",
    };

    const first = await fetch(`${baseUrl}/api/admin/slots`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify(payload),
    });
    assert.equal(first.status, 201);

    const second = await fetch(`${baseUrl}/api/admin/slots`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify(payload),
    });
    assert.equal(second.status, 409);
  });
});

test("cancelling a slot removes it from the public endpoint, republishing restores it", async () => {
  await withServer(async (baseUrl) => {
    const cookie = await setupAndLogin(baseUrl);

    const createResponse = await fetch(`${baseUrl}/api/admin/slots`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        startsAt: "2026-10-03T10:00:00.000Z",
        endsAt: "2026-10-03T13:00:00.000Z",
        depositAmount: "20",
      }),
    });
    const { id } = await createResponse.json();

    const cancelResponse = await fetch(`${baseUrl}/api/admin/slots/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ status: "cancelled" }),
    });
    assert.equal(cancelResponse.status, 200);

    const afterCancel = await (await fetch(`${baseUrl}/api/slots`)).json();
    assert.equal(afterCancel.length, 0);

    const republishResponse = await fetch(`${baseUrl}/api/admin/slots/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ status: "open" }),
    });
    assert.equal(republishResponse.status, 200);

    const afterRepublish = await (await fetch(`${baseUrl}/api/slots`)).json();
    assert.equal(afterRepublish.length, 1);
  });
});

test.after(async () => {
  await closePool();
});
