const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const express = require("express");
const multer = require("multer");

const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const DATA_DIR = path.join(ROOT_DIR, "data");
const STORAGE_DIR = path.join(ROOT_DIR, "storage");
const UPLOADS_DIR = path.join(STORAGE_DIR, "uploads");
const BOOKINGS_FILE = path.join(DATA_DIR, "bookings.json");
const GALLERY_FILE = path.join(DATA_DIR, "gallery.json");
const ADMIN_FILE = path.join(DATA_DIR, "admin.json");
const SESSION_COOKIE = "ronja_admin_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const LOGIN_WINDOW_MS = 1000 * 60 * 15;
const MAX_LOGIN_ATTEMPTS = 5;
const allowedUploadTypes = new Map([
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
]);

const loginAttempts = new Map();
const sessions = new Map();

const defaultGallery = [
  {
    id: "sample-ornamental-flow",
    title: "Ornamental Flow",
    description: "Elegante Linien mit weicher Bewegung und ornamentalem Fokus.",
    tags: ["ornamental", "fine line"],
    image: "/assets/gallery/ornamental-flow.svg",
    createdAt: "2026-01-12T10:00:00.000Z",
  },
  {
    id: "sample-botanical-lines",
    title: "Botanical Lines",
    description: "Florale Fine-Line-Ästhetik mit leichter, moderner Komposition.",
    tags: ["floral", "minimal"],
    image: "/assets/gallery/botanical-lines.svg",
    createdAt: "2026-02-20T14:30:00.000Z",
  },
  {
    id: "sample-celestial-script",
    title: "Celestial Script",
    description: "Leichtes Lettering mit feinen Stern- und Sparkle-Details.",
    tags: ["lettering", "celestial"],
    image: "/assets/gallery/celestial-script.svg",
    createdAt: "2026-03-18T16:45:00.000Z",
  },
];

function ensureDir(directoryPath) {
  fs.mkdirSync(directoryPath, { recursive: true });
}

function ensureJsonFile(filePath, fallbackValue) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(fallbackValue, null, 2));
  }
}

function readJson(filePath, fallbackValue) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    return fallbackValue;
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function initializeStorage() {
  ensureDir(DATA_DIR);
  ensureDir(STORAGE_DIR);
  ensureDir(UPLOADS_DIR);
  ensureJsonFile(BOOKINGS_FILE, []);
  ensureJsonFile(GALLERY_FILE, defaultGallery);
  ensureJsonFile(ADMIN_FILE, {
    configured: false,
    passwordHash: "",
    salt: "",
    createdAt: null,
  });
}

function jsonError(res, status, message) {
  return res.status(status).json({ error: message });
}

function sanitizeText(value, maxLength) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, maxLength);
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
  return req.ip || req.headers["x-forwarded-for"] || "unknown";
}

function clearExpiredSessions() {
  const now = Date.now();

  for (const [token, session] of sessions.entries()) {
    if (session.expiresAt <= now) {
      sessions.delete(token);
    }
  }
}

function getSession(req) {
  clearExpiredSessions();
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[SESSION_COOKIE];

  if (!token) {
    return null;
  }

  return sessions.get(token) || null;
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

function requireAdmin(req, res, next) {
  const session = getSession(req);

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
    storage: multer.diskStorage({
      destination: (_, __, callback) => callback(null, UPLOADS_DIR),
      filename: (_, file, callback) => {
        const extension = allowedUploadTypes.get(file.mimetype) || ".bin";
        callback(null, `${crypto.randomUUID()}${extension}`);
      },
    }),
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

function sortByNewest(items, fieldName = "createdAt") {
  return [...items].sort(
    (left, right) =>
      new Date(right[fieldName] || right.submittedAt || 0).getTime() -
      new Date(left[fieldName] || left.submittedAt || 0).getTime()
  );
}

function createApp() {
  initializeStorage();

  const app = express();
  const upload = createUploadMiddleware();

  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false, limit: "1mb" }));
  app.use((req, res, next) => {
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
    );
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    next();
  });

  app.use("/media", express.static(UPLOADS_DIR));
  app.use(express.static(PUBLIC_DIR));

  app.get("/admin", (_, res) => {
    res.sendFile(path.join(PUBLIC_DIR, "admin.html"));
  });

  app.get("/api/gallery", (_, res) => {
    res.json(sortByNewest(readJson(GALLERY_FILE, defaultGallery)));
  });

  app.post("/api/bookings", (req, res) => {
    const booking = {
      id: crypto.randomUUID(),
      name: sanitizeText(req.body.name, 80),
      email: sanitizeText(req.body.email, 120).toLowerCase(),
      phone: sanitizeText(req.body.phone, 40),
      preferredDate: sanitizeText(req.body.preferredDate, 40),
      placement: sanitizeText(req.body.placement, 80),
      size: sanitizeText(req.body.size, 80),
      designIdea: sanitizeText(req.body.designIdea, 1500),
      status: "pending",
      submittedAt: new Date().toISOString(),
    };

    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (booking.name.length < 2) {
      return jsonError(res, 400, "Bitte einen Namen mit mindestens zwei Zeichen angeben.");
    }
    if (!emailPattern.test(booking.email)) {
      return jsonError(res, 400, "Bitte eine gültige E-Mail-Adresse angeben.");
    }
    if (!booking.preferredDate) {
      return jsonError(res, 400, "Bitte einen Wunschtermin angeben.");
    }
    if (booking.designIdea.length < 20) {
      return jsonError(
        res,
        400,
        "Bitte beschreibe deine Tattoo-Idee mit mindestens 20 Zeichen."
      );
    }

    const bookings = readJson(BOOKINGS_FILE, []);
    bookings.push(booking);
    writeJson(BOOKINGS_FILE, bookings);

    return res.status(201).json({
      message: "Danke! Deine Anfrage ist eingegangen und wartet jetzt auf Freigabe.",
    });
  });

  app.get("/api/admin/status", (req, res) => {
    const adminSettings = readJson(ADMIN_FILE, {});
    res.json({
      configured: Boolean(adminSettings.configured),
      authenticated: Boolean(getSession(req)),
    });
  });

  app.post("/api/admin/setup", (req, res) => {
    const adminSettings = readJson(ADMIN_FILE, {});

    if (adminSettings.configured) {
      return jsonError(res, 409, "Der Admin-Zugang wurde bereits eingerichtet.");
    }

    const password = String(req.body.password || "");
    if (password.length < 10) {
      return jsonError(res, 400, "Bitte ein Passwort mit mindestens 10 Zeichen wählen.");
    }

    const credentials = hashPassword(password);
    writeJson(ADMIN_FILE, {
      configured: true,
      ...credentials,
      createdAt: new Date().toISOString(),
    });

    return res.status(201).json({ message: "Admin-Zugang erfolgreich eingerichtet." });
  });

  app.post("/api/admin/login", (req, res) => {
    const adminSettings = readJson(ADMIN_FILE, {});

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

    const token = crypto.randomUUID();
    sessions.set(token, {
      createdAt: Date.now(),
      expiresAt: Date.now() + SESSION_TTL_MS,
    });
    setSessionCookie(res, token);

    return res.json({ message: "Erfolgreich angemeldet." });
  });

  app.post("/api/admin/logout", (req, res) => {
    const sessionToken = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (sessionToken) {
      sessions.delete(sessionToken);
    }

    clearSessionCookie(res);
    return res.json({ message: "Erfolgreich abgemeldet." });
  });

  app.get("/api/admin/bookings", requireAdmin, (_, res) => {
    res.json(sortByNewest(readJson(BOOKINGS_FILE, []), "submittedAt"));
  });

  app.patch("/api/admin/bookings/:bookingId", requireAdmin, (req, res) => {
    const nextStatus = sanitizeText(req.body.status, 20).toLowerCase();
    if (!["pending", "approved", "rejected"].includes(nextStatus)) {
      return jsonError(res, 400, "Ungültiger Status.");
    }

    const bookings = readJson(BOOKINGS_FILE, []);
    const bookingIndex = bookings.findIndex(
      (entry) => entry.id === req.params.bookingId
    );

    if (bookingIndex < 0) {
      return jsonError(res, 404, "Die Buchung wurde nicht gefunden.");
    }

    bookings[bookingIndex] = {
      ...bookings[bookingIndex],
      status: nextStatus,
      reviewedAt: new Date().toISOString(),
    };
    writeJson(BOOKINGS_FILE, bookings);

    return res.json({ message: "Buchung aktualisiert." });
  });

  app.post(
    "/api/admin/gallery",
    requireAdmin,
    upload.single("image"),
    (req, res) => {
      if (!req.file) {
        return jsonError(res, 400, "Bitte eine Bilddatei auswählen.");
      }

      const entry = {
        id: crypto.randomUUID(),
        title: sanitizeText(req.body.title, 80) || "Neues Tattoo",
        description: sanitizeText(req.body.description, 240),
        tags: sanitizeText(req.body.tags, 120)
          .split(",")
          .map((tag) => sanitizeText(tag, 24))
          .filter(Boolean)
          .slice(0, 6),
        image: `/media/${req.file.filename}`,
        createdAt: new Date().toISOString(),
      };

      const galleryEntries = readJson(GALLERY_FILE, defaultGallery);
      galleryEntries.push(entry);
      writeJson(GALLERY_FILE, galleryEntries);

      return res.status(201).json({ message: "Galeriebild hochgeladen." });
    }
  );

  app.delete("/api/admin/gallery/:entryId", requireAdmin, (req, res) => {
    const galleryEntries = readJson(GALLERY_FILE, defaultGallery);
    const entry = galleryEntries.find((item) => item.id === req.params.entryId);

    if (!entry) {
      return jsonError(res, 404, "Das Galeriebild wurde nicht gefunden.");
    }

    const remainingEntries = galleryEntries.filter(
      (item) => item.id !== req.params.entryId
    );
    writeJson(GALLERY_FILE, remainingEntries);

    if (entry.image.startsWith("/media/")) {
      const filename = path.basename(entry.image);
      const uploadPath = path.join(UPLOADS_DIR, filename);
      if (fs.existsSync(uploadPath)) {
        fs.unlinkSync(uploadPath);
      }
    }

    return res.json({ message: "Galeriebild gelöscht." });
  });

  app.use((error, _, res, next) => {
    if (res.headersSent) {
      return next(error);
    }

    if (error instanceof multer.MulterError) {
      return jsonError(res, 400, "Der Upload konnte nicht verarbeitet werden.");
    }

    if (error) {
      return jsonError(res, 400, error.message || "Es ist ein Fehler aufgetreten.");
    }

    return next();
  });

  return app;
}

if (require.main === module) {
  const app = createApp();
  const port = Number(process.env.PORT || 3000);

  app.listen(port, () => {
    console.log(`Ronja Tattoo läuft auf http://localhost:${port}`);
  });
}

module.exports = {
  ADMIN_FILE,
  BOOKINGS_FILE,
  GALLERY_FILE,
  UPLOADS_DIR,
  createApp,
  defaultGallery,
  initializeStorage,
  writeJson,
};
