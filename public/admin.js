const setupPanel = document.querySelector("#setup-panel");
const loginPanel = document.querySelector("#login-panel");
const dashboard = document.querySelector("#dashboard");
const adminMessage = document.querySelector("#admin-message");
const bookingList = document.querySelector("#booking-list");
const adminGalleryGrid = document.querySelector("#admin-gallery-grid");
const setupForm = document.querySelector("#setup-form");
const loginForm = document.querySelector("#login-form");
const uploadForm = document.querySelector("#upload-form");
const logoutButton = document.querySelector("#logout-button");

function setMessage(message, type = "") {
  adminMessage.textContent = message;
  adminMessage.className = `status-message ${type}`.trim();
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function showState({ configured, authenticated }) {
  setupPanel.hidden = configured;
  loginPanel.hidden = !configured || authenticated;
  dashboard.hidden = !authenticated;
}

async function getJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || "Unbekannter Fehler.");
  }

  return data;
}

function bookingStatusBadge(status) {
  const labelMap = {
    pending: "Pending",
    approved: "Freigegeben",
    rejected: "Abgelehnt",
  };

  return `<span class="status-pill ${status}">${labelMap[status] || status}</span>`;
}

function renderBookings(bookings) {
  if (!bookings.length) {
    bookingList.innerHTML =
      '<p class="section-text">Aktuell liegen keine Termin-Anfragen vor.</p>';
    return;
  }

  bookingList.innerHTML = bookings
    .map(
      (booking) => `
        <article class="booking-card">
          <div class="booking-card-header">
            <div>
              <h3>${escapeHtml(booking.name)}</h3>
              <p class="booking-meta">${escapeHtml(booking.email)} · ${escapeHtml(
                booking.phone || "kein Kontaktkanal"
              )}</p>
            </div>
            ${bookingStatusBadge(booking.status)}
          </div>
          <p><strong>Wunschtermin:</strong> ${escapeHtml(booking.preferredDate)}</p>
          <p><strong>Körperstelle:</strong> ${escapeHtml(booking.placement || "offen")}</p>
          <p><strong>Größe:</strong> ${escapeHtml(booking.size || "offen")}</p>
          <p>${escapeHtml(booking.designIdea)}</p>
          <div class="booking-actions">
            <button class="button status" data-status="approved" data-booking-id="${booking.id}" type="button">Freigeben</button>
            <button class="button status" data-status="pending" data-booking-id="${booking.id}" type="button">Auf pending</button>
            <button class="button status" data-status="rejected" data-booking-id="${booking.id}" type="button">Ablehnen</button>
          </div>
        </article>
      `
    )
    .join("");
}

function renderGallery(entries) {
  if (!entries.length) {
    adminGalleryGrid.innerHTML =
      '<p class="section-text">Noch keine Galerie-Einträge vorhanden.</p>';
    return;
  }

  adminGalleryGrid.innerHTML = entries
    .map(
      (entry) => `
        <article class="gallery-card">
          <img src="${escapeHtml(entry.image)}" alt="${escapeHtml(entry.title)}" loading="lazy" />
          <div class="gallery-card-content admin">
            <div class="gallery-card-header">
              <div>
                <h3>${escapeHtml(entry.title)}</h3>
                <p>${escapeHtml(entry.description || "")}</p>
              </div>
            </div>
            <div class="tag-list">
              ${(entry.tags || [])
                .map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`)
                .join("")}
            </div>
            <div class="gallery-actions">
              <button class="button ghost" data-delete-gallery-id="${entry.id}" type="button">Löschen</button>
            </div>
          </div>
        </article>
      `
    )
    .join("");
}

async function loadDashboard() {
  const [bookings, galleryEntries] = await Promise.all([
    getJson("/api/admin/bookings"),
    getJson("/api/gallery"),
  ]);

  renderBookings(bookings);
  renderGallery(galleryEntries);
}

async function refreshState() {
  const state = await getJson("/api/admin/status");
  showState(state);

  if (state.authenticated) {
    await loadDashboard();
  }
}

document.addEventListener("click", async (event) => {
  const bookingButton = event.target.closest("[data-booking-id]");
  if (bookingButton) {
    try {
      await getJson(`/api/admin/bookings/${bookingButton.dataset.bookingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: bookingButton.dataset.status }),
      });
      setMessage("Buchungsstatus aktualisiert.", "status-success");
      await loadDashboard();
    } catch (error) {
      setMessage(error.message, "status-error");
    }
  }

  const galleryButton = event.target.closest("[data-delete-gallery-id]");
  if (galleryButton) {
    try {
      await getJson(`/api/admin/gallery/${galleryButton.dataset.deleteGalleryId}`, {
        method: "DELETE",
      });
      setMessage("Galerieeintrag gelöscht.", "status-success");
      await loadDashboard();
    } catch (error) {
      setMessage(error.message, "status-error");
    }
  }
});

setupForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(setupForm);
  const password = String(formData.get("password") || "");
  const confirmPassword = String(formData.get("confirmPassword") || "");

  if (password !== confirmPassword) {
    setMessage("Die Passwörter stimmen nicht überein.", "status-error");
    return;
  }

  try {
    const data = await getJson("/api/admin/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    setMessage(data.message, "status-success");
    setupForm.reset();
    await refreshState();
  } catch (error) {
    setMessage(error.message, "status-error");
  }
});

loginForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(loginForm);

  try {
    const data = await getJson("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: formData.get("password") }),
    });
    setMessage(data.message, "status-success");
    loginForm.reset();
    await refreshState();
  } catch (error) {
    setMessage(error.message, "status-error");
  }
});

uploadForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(uploadForm);

  try {
    const response = await fetch("/api/admin/gallery", {
      method: "POST",
      body: formData,
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Upload fehlgeschlagen.");
    }

    setMessage(data.message, "status-success");
    uploadForm.reset();
    await loadDashboard();
  } catch (error) {
    setMessage(error.message, "status-error");
  }
});

logoutButton?.addEventListener("click", async () => {
  try {
    const data = await getJson("/api/admin/logout", { method: "POST" });
    setMessage(data.message, "status-success");
    await refreshState();
  } catch (error) {
    setMessage(error.message, "status-error");
  }
});

document.addEventListener("DOMContentLoaded", async () => {
  try {
    await refreshState();
  } catch (error) {
    setMessage(error.message, "status-error");
  }
});
