const galleryGrid = document.querySelector("#gallery-grid");
const bookingForm = document.querySelector("#booking-form");
const bookingMessage = document.querySelector("#booking-message");
const slotsList = document.querySelector("#slots-list");
const noSlotsNotice = document.querySelector("#no-slots-notice");
const selectedSlotBanner = document.querySelector("#selected-slot-banner");
const changeSlotButton = document.querySelector("#change-slot-button");
const slotIdInput = document.querySelector("#slot-id-input");

let currentSlots = [];

const dateTimeFormatter = new Intl.DateTimeFormat("de-DE", {
  dateStyle: "full",
  timeStyle: "short",
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

function formatSlot(slot) {
  return `${dateTimeFormatter.format(new Date(slot.startsAt))} Uhr${
    slot.label ? ` — ${slot.label}` : ""
  }`;
}

function renderSlotsList(slots) {
  if (!slotsList) {
    return;
  }

  slotsList.innerHTML = slots
    .map(
      (slot) => `
        <article class="glass-card slot-card">
          <div class="slot-card-info">
            <strong>${escapeHtml(
              dateTimeFormatter.format(new Date(slot.startsAt))
            )} Uhr</strong>
            <span>${escapeHtml(slot.label || "")}</span>
          </div>
          <button class="button primary" data-select-slot="${escapeHtml(slot.id)}" type="button">
            Diesen Termin wählen
          </button>
        </article>
      `
    )
    .join("");
}

// show === true switches to the personal-details step for the given slot;
// show === false (or omitted) goes back to the slot-picking step.
function showBookingStep(show, slot) {
  if (!bookingForm || !slotsList) {
    return;
  }

  if (show && slot) {
    slotIdInput.value = slot.id;
    if (selectedSlotBanner) {
      selectedSlotBanner.innerHTML = `<strong>Ausgewählter Termin:</strong> ${escapeHtml(
        formatSlot(slot)
      )}`;
    }
    bookingForm.hidden = false;
    slotsList.hidden = true;
  } else {
    bookingForm.hidden = true;
    slotsList.hidden = false;
  }
}

async function loadSlots() {
  if (!slotsList || !bookingForm || !noSlotsNotice) {
    return;
  }

  const response = await fetch("/api/slots");
  if (!response.ok) {
    throw new Error("Termine konnten nicht geladen werden.");
  }

  currentSlots = await response.json();
  showBookingStep(false);

  if (!currentSlots.length) {
    slotsList.innerHTML = "";
    slotsList.hidden = true;
    noSlotsNotice.hidden = false;
    return;
  }

  noSlotsNotice.hidden = true;
  renderSlotsList(currentSlots);
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

slotsList?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-select-slot]");
  if (!button) {
    return;
  }

  const slot = currentSlots.find((entry) => entry.id === button.dataset.selectSlot);
  if (slot) {
    setMessage(bookingMessage, "");
    showBookingStep(true, slot);
  }
});

changeSlotButton?.addEventListener("click", () => {
  setMessage(bookingMessage, "");
  showBookingStep(false);
});

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
