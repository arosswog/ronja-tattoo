const { Resend } = require("resend");

const FROM_ADDRESS = "Ronja Tattoo <buchung@rnjatatts.com>";
const OWNER_EMAIL = "ronja@rosswog.info";
const ADMIN_URL = "https://rnjatatts.com/admin";

let client = null;

// Lazy singleton, same pattern as lib/db.js: created on first use so
// modules can be required before RESEND_API_KEY is guaranteed to be set.
function getClient() {
  if (!client) {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      throw new Error("RESEND_API_KEY ist nicht gesetzt.");
    }
    client = new Resend(apiKey);
  }
  return client;
}

const dateTimeFormatter = new Intl.DateTimeFormat("de-DE", {
  dateStyle: "full",
  timeStyle: "short",
  timeZone: "Europe/Berlin",
});

function formatEuros(cents) {
  return (cents / 100).toLocaleString("de-DE", { style: "currency", currency: "EUR" });
}

// Booking fields (name, placement, designIdea, ...) are free-text user input
// that only ever went through whitespace/length sanitizing, never HTML
// escaping — required here since it's interpolated into HTML email bodies.
function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function customerConfirmationEmail(booking) {
  const when = dateTimeFormatter.format(new Date(booking.preferredDate));
  return {
    from: FROM_ADDRESS,
    to: [booking.email],
    subject: "Deine Anfrage ist bei Ronja Tattoo eingegangen",
    html: `
      <p>Hallo ${escapeHtml(booking.name)},</p>
      <p>danke für deine Terminanfrage! Sie ist eingegangen und wartet jetzt auf Freigabe:</p>
      <p><strong>Termin:</strong> ${escapeHtml(when)}</p>
      <p>Ronja meldet sich zeitnah bei dir, sobald sie die Anfrage geprüft hat.</p>
      <p>Liebe Grüße<br>Ronja Tattoo</p>
    `,
  };
}

function ownerNotificationEmail(booking) {
  const when = dateTimeFormatter.format(new Date(booking.preferredDate));
  const depositLine =
    booking.depositAmountCents != null
      ? `<p><strong>Anzahlung:</strong> ${formatEuros(booking.depositAmountCents)}</p>`
      : "";

  return {
    from: FROM_ADDRESS,
    to: [OWNER_EMAIL],
    subject: `Neue Buchungsanfrage: ${booking.name}`,
    html: `
      <p>Neue Anfrage für den ${escapeHtml(when)}:</p>
      <ul>
        <li><strong>Name:</strong> ${escapeHtml(booking.name)}</li>
        <li><strong>E-Mail:</strong> ${escapeHtml(booking.email)}</li>
        <li><strong>Telefon:</strong> ${escapeHtml(booking.phone || "–")}</li>
        <li><strong>Platzierung:</strong> ${escapeHtml(booking.placement || "–")}</li>
        <li><strong>Größe:</strong> ${escapeHtml(booking.size || "–")}</li>
      </ul>
      ${depositLine}
      <p><strong>Idee:</strong><br>${escapeHtml(booking.designIdea).replace(/\n/g, "<br>")}</p>
      <p><a href="${ADMIN_URL}">Im Admin-Bereich freigeben oder ablehnen</a></p>
    `,
  };
}

function depositRequestEmail(booking, checkoutUrl) {
  const when = dateTimeFormatter.format(new Date(booking.preferredDate));
  const amount = formatEuros(booking.depositAmountCents);
  return {
    from: FROM_ADDRESS,
    to: [booking.email],
    subject: "Anzahlung für deinen Tattoo-Termin bei Ronja",
    html: `
      <p>Hallo ${escapeHtml(booking.name)},</p>
      <p>dein Termin am <strong>${escapeHtml(when)}</strong> wurde freigegeben! 🎉</p>
      <p>Um den Termin verbindlich zu reservieren, bitte ich dich, eine Anzahlung von <strong>${escapeHtml(amount)}</strong> zu leisten:</p>
      <p><a href="${escapeHtml(checkoutUrl)}" style="display:inline-block;padding:0.75rem 1.5rem;background:#1a1a1a;color:#fff;text-decoration:none;border-radius:8px;">Jetzt Anzahlung bezahlen</a></p>
      <p style="color:#888;font-size:0.85em;">Der Link ist 24 Stunden gültig. Bei Fragen melde dich einfach bei mir.</p>
      <p>Liebe Grüße<br>Ronja Tattoo</p>
    `,
  };
}

function depositReceivedEmailCustomer(booking) {
  const when = dateTimeFormatter.format(new Date(booking.preferredDate));
  const amount = formatEuros(booking.depositAmountCents);
  return {
    from: FROM_ADDRESS,
    to: [booking.email],
    subject: "Anzahlung eingegangen – dein Termin ist fix!",
    html: `
      <p>Hallo ${escapeHtml(booking.name)},</p>
      <p>deine Anzahlung von <strong>${escapeHtml(amount)}</strong> ist eingegangen. Dein Termin am <strong>${escapeHtml(when)}</strong> ist damit fix reserviert. ✓</p>
      <p>Ich freue mich auf dich!</p>
      <p>Liebe Grüße<br>Ronja Tattoo</p>
    `,
  };
}

function depositReceivedEmailOwner(booking) {
  const when = dateTimeFormatter.format(new Date(booking.preferredDate));
  const amount = formatEuros(booking.depositAmountCents);
  return {
    from: FROM_ADDRESS,
    to: [OWNER_EMAIL],
    subject: `Anzahlung eingegangen: ${booking.name}`,
    html: `
      <p><strong>${escapeHtml(booking.name)}</strong> hat die Anzahlung von <strong>${escapeHtml(amount)}</strong> für den Termin am ${escapeHtml(when)} bezahlt.</p>
      <p><a href="${ADMIN_URL}">Im Admin-Bereich ansehen</a></p>
    `,
  };
}

// Fire-and-log: a failed email must never fail the booking request itself,
// the booking is already committed to the DB by the time this runs. The
// Resend SDK returns { data, error } instead of throwing, so each send is
// checked explicitly rather than wrapped in try/catch.
async function notifyBookingRequest(booking) {
  // The test suite runs booking requests against the real DB but must never
  // hit the real Resend API — that would spam Ronja's actual inbox and a
  // test's example.com address on every run.
  if (process.env.NODE_ENV === "test") {
    return;
  }

  const resend = getClient();

  const results = await Promise.all([
    resend.emails.send(customerConfirmationEmail(booking), {
      idempotencyKey: `booking-confirmation/${booking.id}`,
    }),
    resend.emails.send(ownerNotificationEmail(booking), {
      idempotencyKey: `booking-owner-notice/${booking.id}`,
    }),
  ]);

  for (const { error } of results) {
    if (error) {
      console.error("Buchungs-E-Mail konnte nicht gesendet werden:", error);
    }
  }
}

async function notifyDepositRequest(booking, checkoutUrl) {
  if (process.env.NODE_ENV === "test") return;
  const resend = getClient();
  const { error } = await resend.emails.send(depositRequestEmail(booking, checkoutUrl), {
    idempotencyKey: `deposit-request/${booking.id}`,
  });
  if (error) console.error("Zahlungslink-E-Mail fehlgeschlagen:", error);
}

async function notifyDepositReceived(booking) {
  if (process.env.NODE_ENV === "test") return;
  const resend = getClient();
  const results = await Promise.all([
    resend.emails.send(depositReceivedEmailCustomer(booking), {
      idempotencyKey: `deposit-received-customer/${booking.id}`,
    }),
    resend.emails.send(depositReceivedEmailOwner(booking), {
      idempotencyKey: `deposit-received-owner/${booking.id}`,
    }),
  ]);
  for (const { error } of results) {
    if (error) console.error("Zahlungsbestätigungs-E-Mail fehlgeschlagen:", error);
  }
}

module.exports = { notifyBookingRequest, notifyDepositRequest, notifyDepositReceived };
