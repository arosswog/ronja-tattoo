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

test("gallery endpoint returns seeded tattoo artworks", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/gallery`);
    assert.equal(response.status, 200);

    const gallery = await response.json();
    assert.equal(gallery.length, 3);
    assert.equal(gallery[0].title, "Celestial Script");
  });
});

test("booking requests are accepted and stored as pending", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/bookings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Test User",
        email: "test@example.com",
        phone: "@test",
        preferredDate: "2026-08-10",
        placement: "Unterarm",
        size: "10 cm",
        designIdea:
          "Fine-line floral concept with ornamental details for endpoint verification.",
      }),
    });

    assert.equal(response.status, 201);

    const savedBookings = await bookingStore.listBookings();
    assert.equal(savedBookings.length, 1);
    assert.equal(savedBookings[0].status, "pending");
  });
});

test("admin can be configured, logged in, and read bookings", async () => {
  await withServer(async (baseUrl) => {
    const bookingResponse = await fetch(`${baseUrl}/api/bookings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Booking Person",
        email: "booking@example.com",
        phone: "0123",
        preferredDate: "2026-09-10",
        placement: "Schulter",
        size: "15 cm",
        designIdea:
          "Botanical shoulder piece with fine lines and soft ornamental details for testing.",
      }),
    });
    assert.equal(bookingResponse.status, 201);

    const setupResponse = await fetch(`${baseUrl}/api/admin/setup`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ password: "RonjaSecure123" }),
    });
    assert.equal(setupResponse.status, 201);

    const loginResponse = await fetch(`${baseUrl}/api/admin/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ password: "RonjaSecure123" }),
    });
    assert.equal(loginResponse.status, 200);

    const cookie = loginResponse.headers.get("set-cookie");
    assert.ok(cookie);

    const bookingsResponse = await fetch(`${baseUrl}/api/admin/bookings`, {
      headers: {
        Cookie: cookie,
      },
    });
    assert.equal(bookingsResponse.status, 200);

    const bookings = await bookingsResponse.json();
    assert.equal(bookings.length, 1);
    assert.equal(bookings[0].email, "booking@example.com");
  });
});

test("admin can approve a pending booking", async () => {
  await withServer(async (baseUrl) => {
    await fetch(`${baseUrl}/api/bookings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Approve Person",
        email: "approve@example.com",
        phone: "0123",
        preferredDate: "2026-09-11",
        placement: "Arm",
        size: "8 cm",
        designIdea: "Small fine-line piece for approval-flow testing purposes.",
      }),
    });

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
    const cookie = loginResponse.headers.get("set-cookie");

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
