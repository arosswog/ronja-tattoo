const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");

const {
  ADMIN_FILE,
  BOOKINGS_FILE,
  GALLERY_FILE,
  createApp,
  defaultGallery,
  initializeStorage,
  writeJson,
} = require("../server");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function resetData() {
  initializeStorage();
  writeJson(BOOKINGS_FILE, []);
  writeJson(GALLERY_FILE, clone(defaultGallery));
  writeJson(ADMIN_FILE, {
    configured: false,
    passwordHash: "",
    salt: "",
    createdAt: null,
  });
}

async function withServer(run) {
  resetData();
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
    resetData();
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

    const savedBookings = JSON.parse(fs.readFileSync(BOOKINGS_FILE, "utf8"));
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
