const galleryGrid = document.querySelector("#gallery-grid");
const bookingForm = document.querySelector("#booking-form");
const bookingMessage = document.querySelector("#booking-message");

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
}

document.addEventListener("DOMContentLoaded", async () => {
  try {
    await loadGallery();
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
