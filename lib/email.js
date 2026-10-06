const { Resend } = require("resend");

const FROM_ADDRESS = "Ronja Tattoo <buchung@rnjatatts.com>";
const OWNER_EMAIL = "ronja@rosswog.info";
const ADMIN_URL = "https://rnjatatts.com/admin";

// The From domain can only send (no MX), so without an explicit Reply-To every
// customer reply would bounce. Replies must reach Ronja's real mailbox.
const REPLY_TO = OWNER_EMAIL;

function plainText(lines) {
  return lines.join("\n");
}

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
    replyTo: REPLY_TO,
    html: `
      <p>Hallo ${escapeHtml(booking.name)},</p>
      <p>danke für deine Terminanfrage! Sie ist eingegangen und wartet jetzt auf Freigabe:</p>
      <p><strong>Termin:</strong> ${escapeHtml(when)}</p>
      <p>Ronja meldet sich zeitnah bei dir, sobald sie die Anfrage geprüft hat.</p>
      <p>Liebe Grüße<br>Ronja Tattoo</p>
    `,
    text: plainText([
      `Hallo ${booking.name},`,
      "",
      "danke für deine Terminanfrage! Sie ist eingegangen und wartet jetzt auf Freigabe:",
      "",
      `Termin: ${when}`,
      "",
      "Ronja meldet sich zeitnah bei dir, sobald sie die Anfrage geprüft hat.",
      "",
      "Liebe Grüße",
      "Ronja Tattoo",
    ]),
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
    replyTo: REPLY_TO,
    html: `
      <p>Neue Anfrage für den ${escapeHtml(when)}:</p>
      <ul>
        <li><strong>Name:</strong> ${escapeHtml(booking.name)}</li>
        <li><strong>E-Mail:</strong> ${escapeHtml(booking.email)}</li>
        <li><strong>Instagram:</strong> ${escapeHtml(booking.instagram || "–")}</li>
        <li><strong>Platzierung:</strong> ${escapeHtml(booking.placement || "–")}</li>
        <li><strong>Größe:</strong> ${escapeHtml(booking.size || "–")}</li>
      </ul>
      ${depositLine}
      <p><strong>Idee:</strong><br>${escapeHtml(booking.designIdea).replace(/\n/g, "<br>")}</p>
      <p><a href="${ADMIN_URL}">Im Admin-Bereich freigeben oder ablehnen</a></p>
    `,
    text: plainText([
      `Neue Anfrage für den ${when}:`,
      "",
      `Name: ${booking.name}`,
      `E-Mail: ${booking.email}`,
      `Instagram: ${booking.instagram || "–"}`,
      `Platzierung: ${booking.placement || "–"}`,
      `Größe: ${booking.size || "–"}`,
      booking.depositAmountCents != null ? `Anzahlung: ${formatEuros(booking.depositAmountCents)}` : null,
      "",
      "Idee:",
      booking.designIdea,
      "",
      `Im Admin-Bereich freigeben oder ablehnen: ${ADMIN_URL}`,
    ].filter((line) => line !== null)),
  };
}

function depositRequestEmail(booking, checkoutUrl) {
  const when = dateTimeFormatter.format(new Date(booking.preferredDate));
  const amount = formatEuros(booking.depositAmountCents);
  return {
    from: FROM_ADDRESS,
    to: [booking.email],
    subject: "Anzahlung für deinen Tattoo-Termin bei Ronja",
    replyTo: REPLY_TO,
    html: `
      <p>Hallo ${escapeHtml(booking.name)},</p>
      <p>dein Termin am <strong>${escapeHtml(when)}</strong> wurde freigegeben! 🎉</p>
      <p>Um den Termin verbindlich zu reservieren, bitte ich dich, eine Anzahlung von <strong>${escapeHtml(amount)}</strong> zu leisten:</p>
      <p><a href="${escapeHtml(checkoutUrl)}" style="display:inline-block;padding:0.75rem 1.5rem;background:#1a1a1a;color:#fff;text-decoration:none;border-radius:8px;">Jetzt Anzahlung bezahlen</a></p>
      <p style="color:#888;font-size:0.85em;">Der Link ist 24 Stunden gültig. Bei Fragen melde dich einfach bei mir.</p>
      <p style="color:#888;font-size:0.85em;">Tipp: Sollte diese E-Mail im Spam-Ordner gelandet sein, markiere sie bitte einmal als „kein Spam“ – dann kommen meine Nachrichten künftig zuverlässig an.</p>
      <p>Liebe Grüße<br>Ronja Tattoo</p>
    `,
    text: plainText([
      `Hallo ${booking.name},`,
      "",
      `dein Termin am ${when} wurde freigegeben!`,
      "",
      `Um den Termin verbindlich zu reservieren, bitte ich dich, eine Anzahlung von ${amount} zu leisten:`,
      checkoutUrl,
      "",
      "Der Link ist 24 Stunden gültig. Bei Fragen melde dich einfach bei mir.",
      "",
      'Tipp: Sollte diese E-Mail im Spam-Ordner gelandet sein, markiere sie bitte einmal als "kein Spam" - dann kommen meine Nachrichten künftig zuverlässig an.',
      "",
      "Liebe Grüße",
      "Ronja Tattoo",
    ]),
  };
}

// Sent when a checkout session expired: the appointment is kept, and this
// recovery link stays valid for 30 days, so a customer who finds the mail late
// can still pay.
function depositRecoveryEmail(booking, recoveryUrl) {
  const when = dateTimeFormatter.format(new Date(booking.preferredDate));
  const amount = formatEuros(booking.depositAmountCents);
  return {
    from: FROM_ADDRESS,
    to: [booking.email],
    subject: "Neuer Zahlungslink für deinen Tattoo-Termin bei Ronja",
    replyTo: REPLY_TO,
    html: `
      <p>Hallo ${escapeHtml(booking.name)},</p>
      <p>dein Termin am <strong>${escapeHtml(when)}</strong> ist weiterhin für dich reserviert.</p>
      <p>Der Zahlungslink aus meiner letzten E-Mail ist inzwischen abgelaufen. Hier ist ein neuer Link für deine Anzahlung von <strong>${escapeHtml(amount)}</strong>:</p>
      <p><a href="${escapeHtml(recoveryUrl)}" style="display:inline-block;padding:0.75rem 1.5rem;background:#1a1a1a;color:#fff;text-decoration:none;border-radius:8px;">Jetzt Anzahlung bezahlen</a></p>
      <p style="color:#888;font-size:0.85em;">Dieser Link ist 30 Tage gültig. Bei Fragen melde dich einfach bei mir.</p>
      <p>Liebe Grüße<br>Ronja Tattoo</p>
    `,
    text: plainText([
      `Hallo ${booking.name},`,
      "",
      `dein Termin am ${when} ist weiterhin für dich reserviert.`,
      "",
      `Der Zahlungslink aus meiner letzten E-Mail ist abgelaufen. Hier ist ein neuer Link für deine Anzahlung von ${amount}:`,
      recoveryUrl,
      "",
      "Dieser Link ist 30 Tage gültig. Bei Fragen melde dich einfach bei mir.",
      "",
      "Liebe Grüße",
      "Ronja Tattoo",
    ]),
  };
}

function depositReceivedEmailCustomer(booking) {
  const when = dateTimeFormatter.format(new Date(booking.preferredDate));
  const amount = formatEuros(booking.depositAmountCents);
  return {
    from: FROM_ADDRESS,
    to: [booking.email],
    subject: "Anzahlung eingegangen – dein Termin ist fix!",
    replyTo: REPLY_TO,
    html: `
      <p>Hallo ${escapeHtml(booking.name)},</p>
      <p>deine Anzahlung von <strong>${escapeHtml(amount)}</strong> ist eingegangen. Dein Termin am <strong>${escapeHtml(when)}</strong> ist damit fix reserviert. ✓</p>
      <p>Ich freue mich auf dich!</p>
      <p>Liebe Grüße<br>Ronja Tattoo</p>
    `,
    text: plainText([
      `Hallo ${booking.name},`,
      "",
      `deine Anzahlung von ${amount} ist eingegangen. Dein Termin am ${when} ist damit fix reserviert.`,
      "",
      "Ich freue mich auf dich!",
      "",
      "Liebe Grüße",
      "Ronja Tattoo",
    ]),
  };
}

function depositReceivedEmailOwner(booking) {
  const when = dateTimeFormatter.format(new Date(booking.preferredDate));
  const amount = formatEuros(booking.depositAmountCents);
  return {
    from: FROM_ADDRESS,
    to: [OWNER_EMAIL],
    subject: `Anzahlung eingegangen: ${booking.name}`,
    replyTo: REPLY_TO,
    html: `
      <p><strong>${escapeHtml(booking.name)}</strong> hat die Anzahlung von <strong>${escapeHtml(amount)}</strong> für den Termin am ${escapeHtml(when)} bezahlt.</p>
      <p><a href="${ADMIN_URL}">Im Admin-Bereich ansehen</a></p>
    `,
    text: plainText([
      `${booking.name} hat die Anzahlung von ${amount} für den Termin am ${when} bezahlt.`,
      "",
      `Im Admin-Bereich ansehen: ${ADMIN_URL}`,
    ]),
  };
}

function normalizedSendResult(result, recipient) {
  if (result?.error) {
    return {
      recipient,
      providerEmailId: null,
      status: "failed",
      error: result.error.message || result.error.name || "Resend hat die E-Mail abgelehnt.",
    };
  }
  return {
    recipient,
    providerEmailId: result?.data?.id || null,
    status: result?.data?.id ? "sent" : "failed",
    error: result?.data?.id ? null : "Resend hat keine E-Mail-ID zurückgegeben.",
  };
}

function normalizeSettledSendResult(outcome, recipient) {
  if (outcome.status === "rejected") {
    return {
      recipient,
      providerEmailId: null,
      status: "failed",
      error: outcome.reason?.message || "E-Mail-Versand fehlgeschlagen.",
    };
  }
  return normalizedSendResult(outcome.value, recipient);
}

async function sendCustomerConfirmation(booking, { retryKey } = {}) {
  if (process.env.NODE_ENV === "test") return null;
  const result = await getClient().emails.send(customerConfirmationEmail(booking), {
    idempotencyKey: retryKey || `booking-confirmation/${booking.id}`,
  });
  return normalizedSendResult(result, booking.email);
}

// Await and record: Vercel may freeze a serverless invocation as soon as its HTTP response
// is returned, so both provider submissions must finish before the booking endpoint responds.
async function notifyBookingRequest(booking) {
  if (process.env.NODE_ENV === "test") return null;

  const resend = getClient();
  const [customerResult, ownerResult] = await Promise.allSettled([
    resend.emails.send(customerConfirmationEmail(booking), {
      idempotencyKey: `booking-confirmation/${booking.id}`,
    }),
    resend.emails.send(ownerNotificationEmail(booking), {
      idempotencyKey: `booking-owner-notice/${booking.id}`,
    }),
  ]);

  return {
    customer: normalizeSettledSendResult(customerResult, booking.email),
    owner: normalizeSettledSendResult(ownerResult, OWNER_EMAIL),
  };
}

function verifyWebhook({ payload, headers, webhookSecret }) {
  return getClient().webhooks.verify({ payload, headers, webhookSecret });
}

async function notifyDepositRequest(booking, checkoutUrl, { idempotencyKey } = {}) {
  if (process.env.NODE_ENV === "test") return null;
  // Each checkout session gets its own key: reusing one key would make Resend
  // deduplicate a manual re-send and silently return the old email instead.
  const result = await getClient().emails.send(depositRequestEmail(booking, checkoutUrl), {
    idempotencyKey: idempotencyKey || `deposit-request/${booking.id}`,
  });
  return normalizedSendResult(result, booking.email);
}

async function notifyDepositRecovery(booking, recoveryUrl, { idempotencyKey } = {}) {
  if (process.env.NODE_ENV === "test") return null;
  const result = await getClient().emails.send(depositRecoveryEmail(booking, recoveryUrl), {
    idempotencyKey: idempotencyKey || `deposit-recovery/${booking.id}/${Date.now()}`,
  });
  return normalizedSendResult(result, booking.email);
}

async function notifyDepositReceived(booking) {
  if (process.env.NODE_ENV === "test") return null;
  const resend = getClient();
  const [customerResult, ownerResult] = await Promise.allSettled([
    resend.emails.send(depositReceivedEmailCustomer(booking), {
      idempotencyKey: `deposit-received-customer/${booking.id}`,
    }),
    resend.emails.send(depositReceivedEmailOwner(booking), {
      idempotencyKey: `deposit-received-owner/${booking.id}`,
    }),
  ]);
  return {
    customer: normalizeSettledSendResult(customerResult, booking.email),
    owner: normalizeSettledSendResult(ownerResult, OWNER_EMAIL),
  };
}

const emailTemplates = {
  customerConfirmationEmail,
  ownerNotificationEmail,
  depositRequestEmail,
  depositRecoveryEmail,
  depositReceivedEmailCustomer,
  depositReceivedEmailOwner,
};

module.exports = {
  normalizeSettledSendResult,
  notifyBookingRequest,
  sendCustomerConfirmation,
  verifyWebhook,
  notifyDepositRequest,
  notifyDepositRecovery,
  notifyDepositReceived,
  emailTemplates,
};
