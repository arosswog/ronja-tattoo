const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const { createApp } = require("../server");
const { query, closePool } = require("../lib/db");
const { runMigrations } = require("../lib/migrate");
const bookingStore = require("../lib/store/bookings");

async function resetData() {
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

async function withServer(run) {
  await resetData();
  const app = createApp();
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
