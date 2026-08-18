const galleryGrid = document.querySelector("#gallery-grid");
const bookingForm = document.querySelector("#booking-form");
const bookingMessage = document.querySelector("#booking-message");
const slotSelect = document.querySelector("#slot-select");
const noSlotsNotice = document.querySelector("#no-slots-notice");

// Slots are whole days, not time ranges — date only, no time-of-day.
const dateFormatter = new Intl.DateTimeFormat("de-DE", {
  dateStyle: "full",
  timeZone: "Europe/Berlin",
});

function setMessage(element, message, type = "") {
  if (!element) {
    return;
  }

  element.textContent = message;
  element.className = `status-message ${type}`.trim();
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderTags(tags = []) {
  return tags
    .map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`)
    .join("");
}

function renderGallery(items) {
  if (!galleryGrid) {
    return;
  }

  if (!items.length) {
    galleryGrid.innerHTML = '<p class="section-text">Noch keine Bilder vorhanden.</p>';
    return;
  }

  galleryGrid.innerHTML = items
    .map(
      (item) => `
        <article class="gallery-card">
          <img src="${escapeHtml(item.image)}" alt="${escapeHtml(item.title)}" loading="lazy" />
          <div class="gallery-card-content">
            <div class="gallery-card-header">
              <div>
                <h4>${escapeHtml(item.title)}</h4>
                <p>${escapeHtml(item.description || "")}</p>
              </div>
            </div>
            <div class="tag-list">${renderTags(item.tags)}</div>
          </div>
        </article>
      `
    )
    .join("");
}

async function loadGallery() {
  const response = await fetch("/api/gallery");
  if (!response.ok) {
    throw new Error("Galerie konnte nicht geladen werden.");
  }

  const items = await response.json();
  renderGallery(items);
}

async function loadSlots() {
  if (!slotSelect || !bookingForm || !noSlotsNotice) {
    return;
  }

  const response = await fetch("/api/slots");
  if (!response.ok) {
    throw new Error("Termine konnten nicht geladen werden.");
  }

  const slots = await response.json();

  if (!slots.length) {
    bookingForm.hidden = true;
    noSlotsNotice.hidden = false;
    return;
  }

  slotSelect.innerHTML =
    '<option value="" disabled selected>Termin wählen …</option>' +
    slots
      .map(
        (slot) =>
          `<option value="${escapeHtml(slot.id)}">${escapeHtml(
            dateFormatter.format(new Date(slot.startsAt))
          )}${slot.label ? ` — ${escapeHtml(slot.label)}` : ""}</option>`
      )
      .join("");

  bookingForm.hidden = false;
  noSlotsNotice.hidden = true;
}

async function submitBooking(event) {
  event.preventDefault();
  const formData = new FormData(bookingForm);
  const payload = Object.fromEntries(formData.entries());

  setMessage(bookingMessage, "Anfrage wird gesendet …");

  const response = await fetch("/api/bookings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Anfrage konnte nicht gesendet werden.");
  }

  bookingForm.reset();
  setMessage(bookingMessage, data.message, "status-success");
  await loadSlots();
}

document.addEventListener("DOMContentLoaded", async () => {
  try {
    await loadGallery();
  } catch (error) {
    setMessage(bookingMessage, error.message, "status-error");
  }

  try {
    await loadSlots();
  } catch (error) {
    setMessage(bookingMessage, error.message, "status-error");
  }

  if (bookingForm) {
    bookingForm.addEventListener("submit", async (event) => {
      try {
        await submitBooking(event);
      } catch (error) {
        setMessage(bookingMessage, error.message, "status-error");
      }
    });
  }
});
