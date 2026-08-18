// Reuses setMessage()/getJson()/escapeHtml() declared in admin.js — plain
// (non-module) scripts on the same page share one global scope, and
// admin.js is loaded first, so these are already defined by the time any
// of this file's event handlers run.

const slotForm = document.querySelector("#slot-form");
const slotBatchRows = document.querySelector("#slot-batch-rows");
const addSlotRowButton = document.querySelector("#add-slot-row");
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
              <h3>${escapeHtml(dateTimeFormatter.format(new Date(slot.startsAt)))} – ${escapeHtml(
                new Intl.DateTimeFormat("de-DE", { timeStyle: "short", timeZone: "Europe/Berlin" }).format(
                  new Date(slot.endsAt)
                )
              )} Uhr</h3>
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

function createSlotRow() {
  const row = document.createElement("div");
  row.className = "slot-batch-row";
  row.innerHTML = `
    <label>
      <span>Tag</span>
      <input type="date" data-field="date" required />
    </label>
    <label>
      <span>Bezeichnung (optional)</span>
      <input type="text" data-field="label" maxlength="120" placeholder="z. B. Fine-Line Session" />
    </label>
    <label>
      <span>Von</span>
      <input type="time" data-field="startTime" required />
    </label>
    <label>
      <span>Bis</span>
      <input type="time" data-field="endTime" required />
    </label>
    <button class="button ghost remove-row" type="button" data-remove-row>Diesen Tag entfernen</button>
  `;
  return row;
}

function addSlotRow() {
  slotBatchRows?.appendChild(createSlotRow());
}

function resetBatchForm() {
  if (slotBatchRows) {
    slotBatchRows.innerHTML = "";
    addSlotRow();
  }
  slotForm?.reset();
}

// A native <input type="date"> gives "YYYY-MM-DD", <input type="time">
// gives "HH:MM". Combined and parsed without a timezone suffix, the
// browser resolves the result in Ronja's own local time (Europe/Berlin),
// exactly matching how the customer-facing display renders it back.
function dateTimeToIso(dateValue, timeValue) {
  return new Date(`${dateValue}T${timeValue}:00`).toISOString();
}

addSlotRowButton?.addEventListener("click", () => addSlotRow());

slotForm?.addEventListener("submit", async (event) => {
  event.preventDefault();

  const depositAmount = new FormData(slotForm).get("depositAmount");
  const rows = [...(slotBatchRows?.querySelectorAll(".slot-batch-row") || [])];

  if (!rows.length) {
    setMessage("Bitte mindestens einen Tag hinzufügen.", "status-error");
    return;
  }

  const entries = rows.map((row) => ({
    date: row.querySelector('[data-field="date"]').value,
    label: row.querySelector('[data-field="label"]').value,
    startTime: row.querySelector('[data-field="startTime"]').value,
    endTime: row.querySelector('[data-field="endTime"]').value,
  }));

  if (entries.some((entry) => !entry.date || !entry.startTime || !entry.endTime)) {
    setMessage(
      "Bitte bei jedem Tag Datum, Start- und Endzeit angeben.",
      "status-error"
    );
    return;
  }

  let succeeded = 0;
  const errors = [];

  // Sequential, not parallel: each POST hits the same rate limiter and
  // gives a clear per-day error if one date in the package conflicts —
  // the rest of the package still goes through.
  for (const entry of entries) {
    try {
      await getJson("/api/admin/slots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          startsAt: dateTimeToIso(entry.date, entry.startTime),
          endsAt: dateTimeToIso(entry.date, entry.endTime),
          label: entry.label,
          depositAmount,
        }),
      });
      succeeded += 1;
    } catch (error) {
      errors.push(`${entry.date}: ${error.message}`);
    }
  }

  if (errors.length) {
    setMessage(
      `${succeeded} von ${entries.length} Terminen veröffentlicht. Nicht geklappt hat: ${errors.join(" · ")}`,
      succeeded > 0 ? "status-success" : "status-error"
    );
  } else {
    setMessage(
      succeeded === 1 ? "1 Termin veröffentlicht." : `${succeeded} Termine veröffentlicht.`,
      "status-success"
    );
  }

  resetBatchForm();
  await loadSlots();
});

document.addEventListener("click", async (event) => {
  const removeButton = event.target.closest("[data-remove-row]");
  if (removeButton) {
    removeButton.closest(".slot-batch-row")?.remove();
    return;
  }

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

addSlotRow();
