const crypto = require("crypto");
const path = require("path");

const express = require("express");
const { rateLimit } = require("express-rate-limit");
const multer = require("multer");
const Stripe = require("stripe");

const { sanitizeText } = require("./lib/sanitize");
const { allowedUploadTypes, uploadGalleryImage, deleteGalleryImage } = require("./lib/blob");
const emailNotifier = require("./lib/email");
const adminStore = require("./lib/store/admin");
const sessionStore = require("./lib/store/sessions");
const galleryStore = require("./lib/store/gallery");
const bookingStore = require("./lib/store/bookings");
const slotStore = require("./lib/store/slots");

let stripeClient = null;
function getStripe() {
  if (!stripeClient) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error("STRIPE_SECRET_KEY ist nicht gesetzt.");
    stripeClient = new Stripe(key);
  }
  return stripeClient;
}

const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const SESSION_COOKIE = "ronja_admin_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const LOGIN_WINDOW_MS = 1000 * 60 * 15;
const MAX_LOGIN_ATTEMPTS = 5;

// Per-IP login lockout stays in-memory (unlike sessions/bookings/gallery,
// this is a soft rate-limit window, not data that must survive a cold
// start — express-rate-limit's own MemoryStore has the identical
// per-instance scoping and is the accepted pattern for this at this scale).
const loginAttempts = new Map();

function jsonError(res, status, message) {
  return res.status(status).json({ error: message });
}

function parseCookies(cookieHeader = "") {
  return cookieHeader
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .reduce((accumulator, entry) => {
      const separatorIndex = entry.indexOf("=");
      const key = separatorIndex >= 0 ? entry.slice(0, separatorIndex) : entry;
      const value = separatorIndex >= 0 ? entry.slice(separatorIndex + 1) : "";
      accumulator[key] = decodeURIComponent(value);
      return accumulator;
    }, {});
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  return {
    salt,
    passwordHash: crypto.scryptSync(password, salt, 64).toString("hex"),
  };
}

function safeCompare(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function getClientKey(req) {
  return req.ip || "unknown";
}

// Admin enters the deposit amount in euros (e.g. "20" or "20,50"); slots are
// stored in integer cents so money never touches floating point.
function parseEuroToCents(value) {
  const normalized = String(value ?? "").trim().replace(",", ".");
  if (!normalized) {
    return null;
  }

  const euros = Number(normalized);
  if (!Number.isFinite(euros) || euros < 0) {
    return null;
  }

  return Math.round(euros * 100);
}

async function getSession(req) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[SESSION_COOKIE];
  return sessionStore.getSession(token);
}

function setSessionCookie(res, token) {
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(
      SESSION_TTL_MS / 1000
    )}`
  );
}

function clearSessionCookie(res) {
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`
  );
}

async function requireAdmin(req, res, next) {
  const session = await getSession(req);

  if (!session) {
    return jsonError(res, 401, "Bitte zuerst im Admin-Bereich anmelden.");
  }

  req.session = session;
  return next();
}

function getLoginWindow(clientKey) {
  const existingWindow = loginAttempts.get(clientKey);

  if (!existingWindow || existingWindow.until <= Date.now()) {
    const windowState = { count: 0, until: Date.now() + LOGIN_WINDOW_MS };
    loginAttempts.set(clientKey, windowState);
    return windowState;
  }

  return existingWindow;
}

function recordLoginFailure(req) {
  const windowState = getLoginWindow(getClientKey(req));
  windowState.count += 1;
}

function clearLoginFailures(req) {
  loginAttempts.delete(getClientKey(req));
}

function isRateLimited(req) {
  const windowState = getLoginWindow(getClientKey(req));
  return windowState.count >= MAX_LOGIN_ATTEMPTS;
}

function createUploadMiddleware() {
  return multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: 8 * 1024 * 1024,
      files: 1,
    },
    fileFilter: (_, file, callback) => {
      if (!allowedUploadTypes.has(file.mimetype)) {
        callback(new Error("Es sind nur JPG-, PNG- oder WEBP-Dateien erlaubt."));
        return;
      }

      callback(null, true);
    },
  });
}

function createApp() {
  const app = express();
  // Vercel (and most hosting proxies) terminate TLS and forward the real
  // client IP via X-Forwarded-For. Trust a single proxy hop so req.ip is
  // accurate and express-rate-limit does not reject the forwarded header.
  app.set("trust proxy", 1);
  const upload = createUploadMiddleware();
  const limiterOptions = {
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_, res) =>
      jsonError(
        res,
        429,
        "Zu viele Anfragen in kurzer Zeit. Bitte warte einen Moment und versuche es erneut."
      ),
  };
  const adminPageLimiter = rateLimit({
    ...limiterOptions,
    windowMs: 1000 * 60,
    limit: 60,
  });
  const bookingLimiter = rateLimit({
    ...limiterOptions,
    windowMs: 1000 * 60 * 15,
    limit: 6,
  });
  const adminMutationLimiter = rateLimit({
    ...limiterOptions,
    windowMs: 1000 * 60 * 15,
    limit: 30,
  });
  const loginLimiter = rateLimit({
    ...limiterOptions,
    windowMs: 1000 * 60 * 15,
    limit: 10,
    skipSuccessfulRequests: true,
  });

  app.disable("x-powered-by");

  // Stripe webhook must receive the raw body — register before express.json().
  app.post("/api/webhooks/stripe", express.raw({ type: "application/json" }), async (req, res) => {
    const sig = req.headers["stripe-signature"];
    const secret = process.env.STRIPE_WEBHOOK_SECRET;

    let event;
    try {
      event = getStripe().webhooks.constructEvent(req.body, sig, secret);
    } catch (err) {
      console.error("Stripe webhook signature check failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const booking = await bookingStore.getBookingByStripeSession(session.id);
      if (booking) {
        await bookingStore.updateDepositStatus(booking.id, {
          depositStatus: "paid",
          stripePaymentIntentId: session.payment_intent,
        });
        emailNotifier.notifyDepositReceived(booking).catch((err) => {
          console.error("Zahlungsbestätigungs-E-Mail fehlgeschlagen:", err);
        });
      }
    }

    if (event.type === "checkout.session.expired") {
      const session = event.data.object;
      const booking = await bookingStore.getBookingByStripeSession(session.id);
      if (booking && booking.depositStatus === "pending") {
        await bookingStore.updateDepositStatus(booking.id, { depositStatus: "failed" });
      }
    }

    return res.json({ received: true });
  });

  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false, limit: "1mb" }));
  app.use((req, res, next) => {
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' data: https://*.public.blob.vercel-storage.com; style-src 'self'; script-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
    );
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    next();
  });

  app.use(express.static(PUBLIC_DIR));

  app.get("/admin", adminPageLimiter, (_, res) => {
    res.sendFile(path.join(PUBLIC_DIR, "admin.html"));
  });

  app.get("/api/version", (_, res) => {
    const { version } = require("./package.json");
    const date = new Date().toISOString().slice(0, 10);
    res.json({ version, date, label: `v${version} · ${date}` });
  });

  app.get("/api/gallery", async (_, res) => {
    res.json(await galleryStore.listGallery());
  });

  app.get("/api/slots", async (_, res) => {
    res.json(await slotStore.listSlots({ status: "open" }));
  });

  app.post("/api/bookings", bookingLimiter, async (req, res) => {
    const name = sanitizeText(req.body.name, 80);
    const email = sanitizeText(req.body.email, 120).toLowerCase();
    const phone = sanitizeText(req.body.phone, 40);
    const slotId = sanitizeText(req.body.slotId, 60);
    const placement = sanitizeText(req.body.placement, 80);
    const size = sanitizeText(req.body.size, 80);
    const designIdea = sanitizeText(req.body.designIdea, 1500);

    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (name.length < 2) {
      return jsonError(res, 400, "Bitte einen Namen mit mindestens zwei Zeichen angeben.");
    }
    if (!emailPattern.test(email)) {
      return jsonError(res, 400, "Bitte eine gültige E-Mail-Adresse angeben.");
    }
    if (!slotId) {
      return jsonError(res, 400, "Bitte einen Termin auswählen.");
    }
    if (designIdea.length < 20) {
      return jsonError(
        res,
        400,
        "Bitte beschreibe deine Tattoo-Idee mit mindestens 20 Zeichen."
      );
    }

    let booking;
    try {
      booking = await bookingStore.createBookingForSlot({
        slotId,
        name,
        email,
        phone,
        placement,
        size,
        designIdea,
      });
    } catch (error) {
      if (error.status === 404 || error.status === 409) {
        return jsonError(res, error.status, error.message);
      }
      throw error;
    }

    // Booking is already committed at this point — a broken email
    // integration must never turn into a 500 for a request that actually
    // succeeded, so failures here are logged, not thrown.
    emailNotifier.notifyBookingRequest(booking).catch((error) => {
      console.error("Buchungs-E-Mail-Versand fehlgeschlagen:", error);
    });

    return res.status(201).json({
      message: "Danke! Deine Anfrage ist eingegangen und wartet jetzt auf Freigabe.",
    });
  });

  app.get("/api/admin/status", async (req, res) => {
    const adminSettings = await adminStore.getAdminSettings();
    res.json({
      configured: adminSettings.configured,
      authenticated: Boolean(await getSession(req)),
    });
  });

  app.post("/api/admin/setup", adminMutationLimiter, async (req, res) => {
    const adminSettings = await adminStore.getAdminSettings();

    if (adminSettings.configured) {
      return jsonError(res, 409, "Der Admin-Zugang wurde bereits eingerichtet.");
    }

    const password = String(req.body.password || "");
    if (password.length < 10) {
      return jsonError(res, 400, "Bitte ein Passwort mit mindestens 10 Zeichen wählen.");
    }

    const credentials = hashPassword(password);
    await adminStore.setAdminCredentials(credentials);

    return res.status(201).json({ message: "Admin-Zugang erfolgreich eingerichtet." });
  });

  app.post("/api/admin/login", loginLimiter, async (req, res) => {
    const adminSettings = await adminStore.getAdminSettings();

    if (!adminSettings.configured) {
      return jsonError(res, 409, "Bitte richte zuerst den Admin-Zugang ein.");
    }

    if (isRateLimited(req)) {
      return jsonError(
        res,
        429,
        "Zu viele fehlgeschlagene Anmeldeversuche. Bitte versuche es in 15 Minuten erneut."
      );
    }

    const password = String(req.body.password || "");
    const passwordHash = crypto
      .scryptSync(password, adminSettings.salt, 64)
      .toString("hex");

    if (!safeCompare(passwordHash, adminSettings.passwordHash)) {
      recordLoginFailure(req);
      return jsonError(res, 401, "Das Passwort ist nicht korrekt.");
    }

    clearLoginFailures(req);

    const token = await sessionStore.createSession(SESSION_TTL_MS);
    setSessionCookie(res, token);

    return res.json({ message: "Erfolgreich angemeldet." });
  });

  app.post("/api/admin/logout", async (req, res) => {
    const sessionToken = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (sessionToken) {
      await sessionStore.deleteSession(sessionToken);
    }

    clearSessionCookie(res);
    return res.json({ message: "Erfolgreich abgemeldet." });
  });

  app.get("/api/admin/bookings", requireAdmin, async (_, res) => {
    res.json(await bookingStore.listBookings());
  });

  app.post(
    "/api/admin/bookings/:bookingId/checkout",
    requireAdmin,
    adminMutationLimiter,
    async (req, res) => {
      const booking = await bookingStore.getBooking(req.params.bookingId);

      if (!booking) return jsonError(res, 404, "Buchung nicht gefunden.");
      if (booking.status !== "approved")
        return jsonError(res, 400, "Nur freigegebene Buchungen können eine Anzahlung anfordern.");
      if (booking.depositStatus === "paid")
        return jsonError(res, 409, "Die Anzahlung wurde bereits bezahlt.");
      if (!booking.depositAmountCents)
        return jsonError(res, 400, "Kein Anzahlungsbetrag für diese Buchung hinterlegt.");

      const baseUrl = (process.env.APP_BASE_URL || "https://www.rnjatatts.com").replace(/\/$/, "");
      const when = new Date(booking.preferredDate).toLocaleDateString("de-DE", {
        dateStyle: "full",
        timeZone: "Europe/Berlin",
      });

      const session = await getStripe().checkout.sessions.create({
        mode: "payment",
        automatic_payment_methods: { enabled: true },
        line_items: [
          {
            price_data: {
              currency: "eur",
              product_data: {
                name: "Anzahlung Tattoo-Termin",
                description: `Termin am ${when}`,
              },
              unit_amount: booking.depositAmountCents,
            },
            quantity: 1,
          },
        ],
        customer_email: booking.email,
        metadata: { bookingId: booking.id },
        expires_at: Math.floor(Date.now() / 1000) + 60 * 60 * 24,
        success_url: `${baseUrl}/zahlung-erfolgreich.html`,
        cancel_url: `${baseUrl}/zahlung-abgebrochen.html`,
      });

      await bookingStore.updateDepositStatus(booking.id, {
        depositStatus: "pending",
        stripeCheckoutSessionId: session.id,
      });

      emailNotifier.notifyDepositRequest(booking, session.url).catch((err) => {
        console.error("Zahlungslink-E-Mail fehlgeschlagen:", err);
      });

      return res.json({ message: `Zahlungslink wurde an ${booking.email} gesendet.` });
    }
  );

  app.patch("/api/admin/bookings/:bookingId", requireAdmin, async (req, res) => {
    const nextStatus = sanitizeText(req.body.status, 20).toLowerCase();
    if (!["pending", "approved", "rejected", "cancelled"].includes(nextStatus)) {
      return jsonError(res, 400, "Ungültiger Status.");
    }

    const updated = await bookingStore.updateBookingStatus(req.params.bookingId, nextStatus);
    if (!updated) {
      return jsonError(res, 404, "Die Buchung wurde nicht gefunden.");
    }

    return res.json({ message: "Buchung aktualisiert." });
  });

  app.get("/api/admin/slots", requireAdmin, async (_, res) => {
    res.json(await slotStore.listSlots());
  });

  app.post("/api/admin/slots", requireAdmin, adminMutationLimiter, async (req, res) => {
    const startsAt = new Date(req.body.startsAt);
    const endsAt = new Date(req.body.endsAt);
    const label = sanitizeText(req.body.label, 120);
    const depositAmountCents = parseEuroToCents(req.body.depositAmount);

    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) {
      return jsonError(res, 400, "Bitte Start- und Endzeit angeben.");
    }
    if (endsAt <= startsAt) {
      return jsonError(res, 400, "Das Ende muss nach dem Start liegen.");
    }
    if (depositAmountCents === null) {
      return jsonError(res, 400, "Bitte einen gültigen Anzahlungsbetrag angeben.");
    }

    try {
      const slot = await slotStore.createSlot({
        startsAt,
        endsAt,
        label,
        depositAmountCents,
      });
      return res.status(201).json(slot);
    } catch (error) {
      if (error.status === 409) {
        return jsonError(res, 409, error.message);
      }
      throw error;
    }
  });

  app.patch("/api/admin/slots/:slotId", requireAdmin, adminMutationLimiter, async (req, res) => {
    const nextStatus = sanitizeText(req.body.status, 20).toLowerCase();
    if (!["open", "cancelled"].includes(nextStatus)) {
      return jsonError(
        res,
        400,
        "Ungültiger Status. Slots können nur veröffentlicht oder zurückgezogen werden."
      );
    }

    const updated = await slotStore.setSlotStatus(req.params.slotId, nextStatus);
    if (!updated) {
      return jsonError(
        res,
        404,
        "Slot wurde nicht gefunden oder ist bereits reserviert/gebucht."
      );
    }

    return res.json(updated);
  });

  app.post(
    "/api/admin/gallery",
    requireAdmin,
    adminMutationLimiter,
    upload.single("image"),
    async (req, res) => {
      if (!req.file) {
        return jsonError(res, 400, "Bitte eine Bilddatei auswählen.");
      }

      const imageUrl = await uploadGalleryImage(req.file);

      await galleryStore.createGalleryEntry({
        title: sanitizeText(req.body.title, 80) || "Neues Tattoo",
        description: sanitizeText(req.body.description, 240),
        tags: sanitizeText(req.body.tags, 120)
          .split(",")
          .map((tag) => sanitizeText(tag, 24))
          .filter(Boolean)
          .slice(0, 6),
        image: imageUrl,
      });

      return res.status(201).json({ message: "Galeriebild hochgeladen." });
    }
  );

  app.patch(
    "/api/admin/gallery/:entryId",
    requireAdmin,
    adminMutationLimiter,
    async (req, res) => {
      const entry = await galleryStore.getGalleryEntry(req.params.entryId);

      if (!entry) {
        return jsonError(res, 404, "Das Galeriebild wurde nicht gefunden.");
      }

      const title = sanitizeText(req.body.title, 80) || "Neues Tattoo";
      const description = sanitizeText(req.body.description, 240);
      const tags = sanitizeText(req.body.tags, 120)
        .split(",")
        .map((tag) => sanitizeText(tag, 24))
        .filter(Boolean)
        .slice(0, 6);

      const updated = await galleryStore.updateGalleryEntry(req.params.entryId, {
        title,
        description,
        tags,
      });

      return res.json(updated);
    }
  );

  app.delete(
    "/api/admin/gallery/:entryId",
    requireAdmin,
    adminMutationLimiter,
    async (req, res) => {
      const entry = await galleryStore.getGalleryEntry(req.params.entryId);

      if (!entry) {
        return jsonError(res, 404, "Das Galeriebild wurde nicht gefunden.");
      }

      await galleryStore.deleteGalleryEntry(req.params.entryId);

      // Only uploaded images (Blob URLs) need cleanup — the seeded
      // placeholder entries point at static /assets/gallery/*.svg files
      // that ship with the app and must stay untouched.
      if (entry.image.startsWith("http")) {
        await deleteGalleryImage(entry.image);
      }

      return res.json({ message: "Galeriebild gelöscht." });
    }
  );

  app.use((error, _, res, next) => {
    if (res.headersSent) {
      return next(error);
    }

    if (error instanceof multer.MulterError) {
      return jsonError(res, 400, "Der Upload konnte nicht verarbeitet werden.");
    }

    if (error) {
      console.error(error);
      return jsonError(res, 400, error.message || "Es ist ein Fehler aufgetreten.");
    }

    return next();
  });

  return app;
}

// The default export must be the Express app itself (a request handler
// function). Vercel's Node runtime treats the file referenced by package.json
// "main" as a serverless entrypoint and rejects it unless the default export is
// a function or server ("Invalid export found in module ... The default export
// must be a function or server."). Returning the app keeps that contract while
// still exposing createApp() as a property for the api/ entrypoint and tests.
const app = createApp();

app.createApp = createApp;

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);

  app.listen(port, () => {
    console.log(`Ronja Tattoo läuft auf http://localhost:${port}`);
  });
}

module.exports = app;
