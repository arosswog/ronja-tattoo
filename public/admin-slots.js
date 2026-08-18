// Reuses setMessage()/getJson()/escapeHtml() declared in admin.js — plain
// (non-module) scripts on the same page share one global scope, and
// admin.js is loaded first, so these are already defined by the time any
// of this file's event handlers run.

const slotForm = document.querySelector("#slot-form");
const slotList = document.querySelector("#slot-list");

const dateTimeFormatter = new Intl.DateTimeFormat("de-DE", {
  dateStyle: "full",
  timeStyle: "short",
  timeZone: "Europe/Berlin",
});

function formatEuros(cents) {
  return (cents / 100).toLocaleString("de-DE", {
    style: "currency",
    currency: "EUR",
  });
}

function slotStatusBadge(status) {
  const labelMap = {
    open: "Offen",
    reserved: "Reserviert",
    booked: "Gebucht",
    cancelled: "Zurückgezogen",
  };

  return `<span class="status-pill ${status}">${labelMap[status] || status}</span>`;
}

function renderSlots(slots) {
  if (!slots.length) {
    slotList.innerHTML = '<p class="section-text">Noch keine Slots angelegt.</p>';
    return;
  }

  slotList.innerHTML = slots
    .map((slot) => {
      const canToggle = slot.status === "open" || slot.status === "cancelled";
      const toggleButton = canToggle
        ? slot.status === "open"
          ? `<button class="button status" data-slot-status="cancelled" data-slot-id="${slot.id}" type="button">Zurückziehen</button>`
          : `<button class="button status" data-slot-status="open" data-slot-id="${slot.id}" type="button">Veröffentlichen</button>`
        : "";

      return `
        <article class="booking-card">
          <div class="booking-card-header">
            <div>
              <h3>${escapeHtml(dateTimeFormatter.format(new Date(slot.startsAt)))}</h3>
              <p class="booking-meta">${escapeHtml(slot.label || "ohne Bezeichnung")} · Anzahlung ${escapeHtml(
                formatEuros(slot.depositAmountCents)
              )}</p>
            </div>
            ${slotStatusBadge(slot.status)}
          </div>
          <div class="booking-actions">${toggleButton}</div>
        </article>
      `;
    })
    .join("");
}

async function loadSlots() {
  const slots = await getJson("/api/admin/slots");
  renderSlots(slots);
}

slotForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(slotForm);

  try {
    await getJson("/api/admin/slots", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        startsAt: new Date(String(formData.get("startsAt"))).toISOString(),
        endsAt: new Date(String(formData.get("endsAt"))).toISOString(),
        label: formData.get("label"),
        depositAmount: formData.get("depositAmount"),
      }),
    });
    setMessage("Slot veröffentlicht.", "status-success");
    slotForm.reset();
    await loadSlots();
  } catch (error) {
    setMessage(error.message, "status-error");
  }
});

document.addEventListener("click", async (event) => {
  const slotButton = event.target.closest("[data-slot-id]");
  if (!slotButton) {
    return;
  }

  try {
    await getJson(`/api/admin/slots/${slotButton.dataset.slotId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: slotButton.dataset.slotStatus }),
    });
    setMessage("Slot aktualisiert.", "status-success");
    await loadSlots();
  } catch (error) {
    setMessage(error.message, "status-error");
  }
});
