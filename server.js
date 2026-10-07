const crypto = require("crypto");
const path = require("path");

const express = require("express");
const { rateLimit } = require("express-rate-limit");
const multer = require("multer");
const Stripe = require("stripe");

const { sanitizeText } = require("./lib/sanitize");
const { allowedUploadTypes, uploadGalleryImage, deleteGalleryImage, uploadReferenceImage } = require("./lib/blob");
const emailNotifier = require("./lib/email");
const adminStore = require("./lib/store/admin");
const sessionStore = require("./lib/store/sessions");
const galleryStore = require("./lib/store/gallery");
const bookingStore = require("./lib/store/bookings");
const emailDeliveryStore = require("./lib/store/email-deliveries");
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

function createUploadMiddleware(maxFiles = 1) {
  return multer({
    storage: multer.memoryStorage(),
    limits: {
      // Must stay below Vercel's ~4.5 MB serverless request-body cap: above it
      // the platform answers with a plain-text 413 and the function never runs.
      fileSize: 4 * 1024 * 1024,
      files: maxFiles,
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

function createApp({ emailService = emailNotifier } = {}) {
  const app = express();
  // Vercel (and most hosting proxies) terminate TLS and forward the real
  // client IP via X-Forwarded-For. Trust a single proxy hop so req.ip is
  // accurate and express-rate-limit does not reject the forwarded header.
  app.set("trust proxy", 1);
  const upload = createUploadMiddleware(1);
  const referenceUpload = createUploadMiddleware(3);
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
        try {
          const results = await emailNotifier.notifyDepositReceived(booking);
          if (results?.customer) {
            await emailDeliveryStore.recordAttempt({
              bookingId: booking.id,
              kind: "deposit_received_customer",
              recipient: booking.email,
              ...results.customer,
            });
          }
          if (results?.owner) {
            await emailDeliveryStore.recordAttempt({
              bookingId: booking.id,
              kind: "deposit_received_owner",
              recipient: results.owner.recipient || "ronja@rosswog.info",
              ...results.owner,
            });
          }
        } catch (error) {
          console.error("Zahlungsbestätigungs-E-Mail fehlgeschlagen:", error);
        }
      }
    }

    if (event.type === "checkout.session.expired") {
      const session = event.data.object;
      const booking = await bookingStore.getBookingByStripeSession(session.id);
      if (booking) {
        // An expired link must not cancel the appointment: keep the booking and
        // the slot, store Stripe's 30-day recovery link and send it out.
        const recoveryUrl = session.after_expiration?.recovery?.url || null;
        const expired = await bookingStore.markDepositExpired(booking.id, recoveryUrl);
        if (expired && recoveryUrl) {
          try {
            const result = await emailNotifier.notifyDepositRecovery(expired, recoveryUrl, {
              idempotencyKey: `deposit-recovery/${expired.id}/${session.id}`,
            });
            if (result) {
              await emailDeliveryStore.recordAttempt({
                bookingId: expired.id,
                kind: "deposit_request",
                recipient: expired.email,
                ...result,
              });
            }
          } catch (error) {
            console.error("Zahlungslink-Wiederherstellung fehlgeschlagen:", error);
          }
        }
      }
    }

    return res.json({ received: true });
  });

  app.post(
    "/api/webhooks/resend",
    express.text({ type: "application/json", limit: "256kb" }),
    async (req, res) => {
      const webhookSecret = process.env.RESEND_WEBHOOK_SECRET;
      if (!webhookSecret) {
        return jsonError(res, 503, "E-Mail-Webhook ist nicht konfiguriert.");
      }

      let event;
      try {
        event = emailService.verifyWebhook({
          payload: req.body,
          headers: {
            id: req.get("svix-id"),
            timestamp: req.get("svix-timestamp"),
            signature: req.get("svix-signature"),
          },
          webhookSecret,
        });
      } catch {
        return jsonError(res, 400, "Ungültige Webhook-Signatur.");
      }

      const statusByEvent = {
        "email.sent": "sent",
        "email.delivered": "delivered",
        "email.delivery_delayed": "delivery_delayed",
        "email.bounced": "bounced",
        "email.failed": "failed",
        "email.suppressed": "suppressed",
        "email.complained": "complained",
      };
      const status = statusByEvent[event.type];
      const providerEmailId = event.data?.email_id;
      if (status && providerEmailId) {
        const detail =
          event.data?.bounce?.message ||
          event.data?.failed?.reason ||
          event.data?.suppressed?.message ||
          null;
        await emailDeliveryStore.updateProviderStatus(
          providerEmailId,
          status,
          detail,
          event.created_at
        );
      }
      return res.json({ received: true });
    }
  );

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

  app.post(
    "/api/bookings",
    bookingLimiter,
    referenceUpload.array("references", 3),
    async (req, res) => {
      const name = sanitizeText(req.body.name, 80);
      const email = sanitizeText(req.body.email, 120).toLowerCase();
      const instagram = sanitizeText(req.body.instagram, 80);
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

      const referenceImages = await Promise.all(
        (req.files || []).map((file) => uploadReferenceImage(file))
      );

      let booking;
      try {
        booking = await bookingStore.createBookingForSlot({
          slotId,
          name,
          email,
          instagram,
          placement,
          size,
          designIdea,
          referenceImages,
        });
      } catch (error) {
        if (error.status === 404 || error.status === 409) {
          return jsonError(res, error.status, error.message);
        }
        throw error;
      }

      try {
        const emailResults = await emailService.notifyBookingRequest(booking);
        if (emailResults?.customer) {
          await emailDeliveryStore.recordAttempt({
            bookingId: booking.id,
            kind: "customer_confirmation",
            recipient: booking.email,
            ...emailResults.customer,
          });
        }
        if (emailResults?.owner) {
          await emailDeliveryStore.recordAttempt({
            bookingId: booking.id,
            kind: "owner_notification",
            recipient: emailResults.owner.recipient || "ronja@rosswog.info",
            ...emailResults.owner,
          });
        }
      } catch (error) {
        console.error("Buchungs-E-Mail-Versand fehlgeschlagen:", error);
        await emailDeliveryStore.recordAttempt({
          bookingId: booking.id,
          kind: "customer_confirmation",
          recipient: booking.email,
          providerEmailId: null,
          status: "failed",
          error,
        });
      }

      return res.status(201).json({
        message: "Danke! Deine Anfrage ist eingegangen und wartet jetzt auf Freigabe.",
      });
    }
  );

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
    const bookings = await bookingStore.listBookings();
    const deliveries = await emailDeliveryStore.deliveriesForBookings(
      bookings.map((booking) => booking.id)
    );
    res.json(
      bookings.map((booking) => {
        const byKind = deliveries.get(booking.id) || {};
        return {
          ...booking,
          emailDelivery: byKind.customer_confirmation || null,
          depositEmailDelivery: byKind.deposit_request || null,
        };
      })
    );
  });

  app.post(
    "/api/admin/bookings/:bookingId/resend-confirmation",
    requireAdmin,
    adminMutationLimiter,
    async (req, res) => {
      const booking = await bookingStore.getBooking(req.params.bookingId);
      if (!booking) {
        return jsonError(res, 404, "Buchungsanfrage wurde nicht gefunden.");
      }
      const reserved = await emailDeliveryStore.reserveCustomerRetry(booking.id, booking.email);
      if (!reserved) {
        return jsonError(
          res,
          409,
          "Für diese Buchungsbestätigung läuft bereits ein Versand oder sie wurde erfolgreich zugestellt."
        );
      }
      let result;
      try {
        result = await emailService.sendCustomerConfirmation(booking, {
          retryKey: `booking-confirmation/${booking.id}/retry/${reserved.attempt_count}`,
        });
      } catch (error) {
        result = { providerEmailId: null, status: "failed", error };
      }
      if (!result) {
        result = {
          providerEmailId: null,
          status: "failed",
          error: "E-Mail-Versand ist derzeit nicht verfügbar.",
        };
      }
      const stored = await emailDeliveryStore.completeCustomerRetry(booking.id, result);
      const emailDelivery = await emailDeliveryStore.customerDeliveryForBooking(booking.id);
      if (stored.status === "failed") {
        return res.status(502).json({
          error: "Buchungsbestätigung konnte nicht gesendet werden.",
          emailDelivery,
        });
      }
      return res.json({
        message: "Buchungsbestätigung erneut an die Kundin gesendet.",
        emailDelivery,
      });
    }
  );

  async function sendCheckoutForBooking(booking) {
    const baseUrl = (process.env.APP_BASE_URL || "https://www.rnjatatts.com").replace(/\/$/, "");
    const when = new Date(booking.preferredDate).toLocaleDateString("de-DE", {
      dateStyle: "full",
      timeZone: "Europe/Berlin",
    });

    const session = await getStripe().checkout.sessions.create({
      mode: "payment",
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
      success_url: `${baseUrl}/zahlung-erfolgreich.html`,
      cancel_url: `${baseUrl}/zahlung-abgebrochen.html`,
      // Stripe keeps a 30-day recovery link for the session, so an expired
      // payment link can be replaced without touching the appointment.
      after_expiration: { recovery: { enabled: true } },
    });

    await bookingStore.updateDepositStatus(booking.id, {
      depositStatus: "pending",
      stripeCheckoutSessionId: session.id,
    });

    try {
      const result = await emailNotifier.notifyDepositRequest(booking, session.url, {
        idempotencyKey: `deposit-request/${booking.id}/${session.id}`,
      });
      if (result) {
        await emailDeliveryStore.recordAttempt({
          bookingId: booking.id,
          kind: "deposit_request",
          recipient: booking.email,
          ...result,
        });
      }
    } catch (error) {
      console.error("Zahlungslink-E-Mail fehlgeschlagen:", error);
      await emailDeliveryStore.recordAttempt({
        bookingId: booking.id,
        kind: "deposit_request",
        recipient: booking.email,
        providerEmailId: null,
        status: "failed",
        error,
      });
    }

    return session;
  }

  // Resend payment link manually (e.g. customer missed the first email).
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

      await sendCheckoutForBooking(booking);

      return res.json({ message: `Zahlungslink wurde an ${booking.email} gesendet.` });
    }
  );

  // Re-send the long-lived Stripe recovery link for a booking whose 24h link
  // expired, without creating yet another short-lived session.
  app.post(
    "/api/admin/bookings/:bookingId/resend-recovery",
    requireAdmin,
    adminMutationLimiter,
    async (req, res) => {
      const booking = await bookingStore.getBooking(req.params.bookingId);
      if (!booking) {
        return jsonError(res, 404, "Buchungsanfrage wurde nicht gefunden.");
      }
      if (!booking.stripeRecoveryUrl) {
        return jsonError(
          res,
          409,
          "Für diese Buchung existiert kein gültiger Wiederherstellungslink. Bitte einen neuen Zahlungslink senden."
        );
      }
      if (booking.status !== "approved" || booking.depositStatus === "paid") {
        return jsonError(res, 409, "Für diese Buchung kann kein Zahlungslink gesendet werden.");
      }

      let result;
      try {
        result = await emailNotifier.notifyDepositRecovery(booking, booking.stripeRecoveryUrl, {
          idempotencyKey: `deposit-recovery/${booking.id}/${Date.now()}`,
        });
      } catch (error) {
        result = { providerEmailId: null, status: "failed", error };
      }
      if (result) {
        await emailDeliveryStore.recordAttempt({
          bookingId: booking.id,
          kind: "deposit_request",
          recipient: booking.email,
          ...result,
        });
      }
      if (result && result.status === "failed") {
        return res.status(502).json({
          error: "Der Zahlungslink konnte nicht gesendet werden.",
          depositEmailDelivery: await emailDeliveryStore.deliveryForBookingKind(
            booking.id,
            "deposit_request"
          ),
        });
      }
      return res.json({
        message: "Wiederherstellungslink wurde an die Kundin gesendet.",
      });
    }
  );

  app.patch("/api/admin/bookings/:bookingId", requireAdmin, adminMutationLimiter, async (req, res) => {
    const nextStatus = sanitizeText(req.body.status, 20).toLowerCase();
    if (!["pending", "approved", "rejected", "cancelled"].includes(nextStatus)) {
      return jsonError(res, 400, "Ungültiger Status.");
    }

    const updated = await bookingStore.updateBookingStatus(req.params.bookingId, nextStatus);
    if (!updated) {
      return jsonError(res, 404, "Die Buchung wurde nicht gefunden.");
    }

    if (nextStatus === "approved" && updated.depositAmountCents) {
      sendCheckoutForBooking(updated).catch((err) => {
        console.error("Auto-Checkout nach Bestätigung fehlgeschlagen:", err);
      });
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
    const status = sanitizeText(req.body.status, 20).toLowerCase() || "open";

    if (!["draft", "open"].includes(status)) {
      return jsonError(res, 400, "Termine können nur als Entwurf gespeichert oder veröffentlicht werden.");
    }
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
        status,
      });
      return res.status(201).json(slot);
    } catch (error) {
      if (error.status === 409) {
        return jsonError(res, 409, error.message);
      }
      throw error;
    }
  });

  app.put("/api/admin/slots/:slotId", requireAdmin, adminMutationLimiter, async (req, res) => {
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
      const updated = await slotStore.updateDraftSlot(req.params.slotId, {
        startsAt,
        endsAt,
        label,
        depositAmountCents,
      });
      if (!updated) {
        return jsonError(res, 409, "Nur gespeicherte Entwürfe können bearbeitet werden.");
      }
      return res.json(updated);
    } catch (error) {
      if (error.status === 409) {
        return jsonError(res, 409, error.message);
      }
      throw error;
    }
  });

  app.get("/api/admin/slots/:slotId/deletion-impact", requireAdmin, async (req, res) => {
    const slot = await slotStore.getSlot(req.params.slotId);
    if (!slot) {
      return jsonError(res, 404, "Dieser Termin existiert nicht mehr.");
    }
    const impact = await slotStore.deletionImpact(slot.id);
    return res.json({ slot, ...impact, requiresDoubleConfirmation: impact.bookingCount > 0 });
  });

  app.delete("/api/admin/slots/:slotId", requireAdmin, adminMutationLimiter, async (req, res) => {
    const slot = await slotStore.getSlot(req.params.slotId);
    if (!slot) {
      return jsonError(res, 404, "Dieser Termin existiert nicht mehr.");
    }

    const impact = await slotStore.deletionImpact(slot.id);
    const confirmation = sanitizeText(req.body?.confirmation, 40);

    if (impact.bookingCount > 0) {
      // Step two of the double confirmation: the UI has to acknowledge that a
      // real customer's appointment (possibly with a paid deposit) disappears.
      if (confirmation !== "DELETE_BOOKED") {
        return res.status(409).json({
          error:
            "Auf diesem Termin liegt eine Buchung. Bitte die doppelte Bestätigung bestätigen.",
          requiresDoubleConfirmation: true,
          ...impact,
        });
      }
      const archived = await slotStore.archiveSlot(slot.id);
      if (!archived) {
        return jsonError(res, 404, "Dieser Termin existiert nicht mehr.");
      }
      return res.json({
        message: "Termin wurde gelöscht. Der Zahlungsbeleg bleibt intern erhalten.",
        archived: true,
      });
    }

    if (confirmation !== "DELETE") {
      return res.status(409).json({
        error: "Bitte den Termin zuerst bestätigen.",
        requiresDoubleConfirmation: false,
        ...impact,
      });
    }

    const deleted = await slotStore.deleteSlot(slot.id);
    if (!deleted) {
      return jsonError(res, 404, "Dieser Termin existiert nicht mehr.");
    }
    return res.json({ message: "Termin wurde gelöscht.", archived: false });
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
      if (error.code === "LIMIT_FILE_SIZE") {
        return jsonError(
          res,
          413,
          "Das Bild ist zu groß zum Hochladen. Bitte wähle ein kleineres Bild oder mach einen Screenshot davon."
        );
      }
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
