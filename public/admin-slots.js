// Reuses setMessage()/getJson()/escapeHtml() declared in admin.js — plain
// (non-module) scripts on the same page share one global scope, and
// admin.js is loaded first, so these are already defined by the time any
// of this file's event handlers run.

const slotForm = document.querySelector("#slot-form");
const slotBatchRows = document.querySelector("#slot-batch-rows");
const addSlotRowButton = document.querySelector("#add-slot-row");
const slotList = document.querySelector("#slot-list");
const slotEditDialog = document.querySelector("#slot-edit-dialog");
const slotEditForm = document.querySelector("#slot-edit-form");
const slotEditCancel = document.querySelector("#slot-edit-cancel");
const hidePastSlots = document.querySelector("#hide-past-slots");
const slotDeleteDialog = document.querySelector("#slot-delete-dialog");
const slotDeleteTitle = document.querySelector("#slot-delete-title");
const slotDeleteSummary = document.querySelector("#slot-delete-summary");
const slotDeleteWarning = document.querySelector("#slot-delete-warning");
const slotDeleteAcknowledge = document.querySelector("#slot-delete-acknowledge");
const slotDeleteConfirmWrap = document.querySelector("#slot-delete-confirm-wrap");
const slotDeleteConfirmButton = document.querySelector("#slot-delete-confirm");
const slotDeleteCancel = document.querySelector("#slot-delete-cancel");
let currentSlots = [];
let pendingDeletion = null;

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
    draft: "Entwurf",
    open: "Veröffentlicht",
    reserved: "Reserviert",
    booked: "Gebucht",
    cancelled: "Zurückgezogen",
  };

  return `<span class="status-pill ${status}">${labelMap[status] || status}</span>`;
}

function renderSlots(slots) {
  const pastCutoff = Date.now();
  const visible = hidePastSlots?.checked
    ? slots.filter((slot) => new Date(slot.endsAt).getTime() >= pastCutoff)
    : slots;
  const hiddenCount = slots.length - visible.length;

  if (!visible.length) {
    slotList.innerHTML = hiddenCount
      ? `<p class="section-text">Keine aktuellen Termine. ${hiddenCount} vergangene Termine sind ausgeblendet.</p>`
      : '<p class="section-text">Noch keine Slots angelegt.</p>';
    return;
  }

  const hiddenHint = hiddenCount
    ? `<p class="section-text">${hiddenCount} vergangene Termine sind ausgeblendet.</p>`
    : "";

  slotList.innerHTML = hiddenHint + visible
    .map((slot) => {
      const editButton = slot.status === "draft"
        ? `<button class="button ghost" data-edit-slot="${slot.id}" type="button">Bearbeiten</button>`
        : "";
      const canToggle = slot.status === "draft" || slot.status === "open" || slot.status === "cancelled";
      const toggleButton = canToggle
        ? slot.status === "open"
          ? `<button class="button status" data-slot-status="cancelled" data-slot-id="${slot.id}" type="button">Zurückziehen</button>`
          : `<button class="button primary" data-slot-status="open" data-slot-id="${slot.id}" type="button">Veröffentlichen</button>`
        : "";
      const deleteButton = `<button class="button danger" data-delete-slot="${slot.id}" type="button">Löschen</button>`;

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
          <div class="booking-actions">${editButton}${toggleButton}${deleteButton}</div>
        </article>
      `;
    })
    .join("");
}

async function loadSlots() {
  currentSlots = await getJson("/api/admin/slots");
  renderSlots(currentSlots);
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

function slotInputValues(slot) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const partsFor = (value) => Object.fromEntries(
    formatter
      .formatToParts(new Date(value))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );
  const startsAt = partsFor(slot.startsAt);
  const endsAt = partsFor(slot.endsAt);
  return {
    date: `${startsAt.year}-${startsAt.month}-${startsAt.day}`,
    startTime: `${startsAt.hour}:${startsAt.minute}`,
    endTime: `${endsAt.hour}:${endsAt.minute}`,
  };
}

addSlotRowButton?.addEventListener("click", () => addSlotRow());

slotForm?.addEventListener("submit", async (event) => {
  event.preventDefault();

  const depositAmount = new FormData(slotForm).get("depositAmount");
  const requestedStatus = event.submitter?.value === "draft" ? "draft" : "open";
  const actionLabel = requestedStatus === "draft" ? "gespeichert" : "veröffentlicht";
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
          status: requestedStatus,
        }),
      });
      succeeded += 1;
    } catch (error) {
      errors.push(`${entry.date}: ${error.message}`);
    }
  }

  if (errors.length) {
    setMessage(
      `${succeeded} von ${entries.length} Terminen ${actionLabel}. Nicht geklappt hat: ${errors.join(" · ")}`,
      succeeded > 0 ? "status-success" : "status-error"
    );
  } else {
    setMessage(
      succeeded === 1 ? `1 Termin ${actionLabel}.` : `${succeeded} Termine ${actionLabel}.`,
      "status-success"
    );
  }

  resetBatchForm();
  await loadSlots();
});

slotEditCancel?.addEventListener("click", () => slotEditDialog?.close());

hidePastSlots?.addEventListener("change", () => renderSlots(currentSlots));

// Step one of the delete flow: ask the server what would disappear, then show
// that answer. A booked appointment needs the second step (checkbox + final
// button); a free one is gone after this one dialog.
function openSlotDeleteDialog(slot, impact) {
  pendingDeletion = { slot, impact };
  const when = dateTimeFormatter.format(new Date(slot.startsAt));
  const booked = impact.bookingCount > 0;

  slotDeleteTitle.textContent = booked ? "Gebuchten Termin löschen?" : "Termin löschen?";
  slotDeleteSummary.textContent = booked
    ? `${when}: Auf diesem Termin liegt die Buchung von ${impact.booking.name}. Beim Löschen verschwindet der Termin aus deiner Liste und von der Website.`
    : `${when}: Dieser Termin ist frei und wird endgültig entfernt.`;

  if (booked && impact.depositPaid) {
    slotDeleteWarning.textContent = `Achtung: Es wurde bereits eine Anzahlung von ${formatEuros(
      impact.depositAmountCents
    )} bezahlt. Der Zahlungsbeleg bleibt intern erhalten.`;
  } else if (booked) {
    slotDeleteWarning.textContent = "Achtung: Auf diesem Termin liegt eine Buchung.";
  } else {
    slotDeleteWarning.textContent = "";
  }

  slotDeleteConfirmWrap.hidden = !booked;
  slotDeleteAcknowledge.checked = false;
  slotDeleteConfirmButton.disabled = booked;
  slotDeleteConfirmButton.textContent = booked ? "Endgültig löschen" : "Löschen";
  slotDeleteDialog?.showModal();
}

slotDeleteAcknowledge?.addEventListener("change", () => {
  slotDeleteConfirmButton.disabled = !slotDeleteAcknowledge.checked;
});

slotDeleteCancel?.addEventListener("click", () => {
  pendingDeletion = null;
  slotDeleteDialog?.close();
});

slotDeleteConfirmButton?.addEventListener("click", async () => {
  if (!pendingDeletion) return;
  const { slot, impact } = pendingDeletion;
  slotDeleteConfirmButton.disabled = true;
  try {
    const data = await getJson(`/api/admin/slots/${slot.id}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        confirmation: impact.bookingCount > 0 ? "DELETE_BOOKED" : "DELETE",
      }),
    });
    pendingDeletion = null;
    slotDeleteDialog?.close();
    setMessage(data.message, "status-success");
    if (typeof loadDashboard === "function") {
      await loadDashboard();
    } else {
      await loadSlots();
    }
  } catch (error) {
    setMessage(error.message, "status-error");
    slotDeleteConfirmButton.disabled = impact.bookingCount > 0;
  }
});

slotEditForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(slotEditForm);
  const slotId = String(formData.get("slotId") || "");

  try {
    await getJson(`/api/admin/slots/${slotId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        startsAt: dateTimeToIso(formData.get("date"), formData.get("startTime")),
        endsAt: dateTimeToIso(formData.get("date"), formData.get("endTime")),
        label: formData.get("label"),
        depositAmount: formData.get("depositAmount"),
      }),
    });
    slotEditDialog?.close();
    setMessage("Entwurf gespeichert.", "status-success");
    await loadSlots();
  } catch (error) {
    setMessage(error.message, "status-error");
  }
});

document.addEventListener("click", async (event) => {
  const deleteButton = event.target.closest("[data-delete-slot]");
  if (deleteButton) {
    const slot = currentSlots.find((item) => item.id === deleteButton.dataset.deleteSlot);
    if (!slot) return;
    try {
      const impact = await getJson(`/api/admin/slots/${slot.id}/deletion-impact`);
      openSlotDeleteDialog(slot, impact);
    } catch (error) {
      setMessage(error.message, "status-error");
    }
    return;
  }

  const editButton = event.target.closest("[data-edit-slot]");
  if (editButton) {
    const slot = currentSlots.find((item) => item.id === editButton.dataset.editSlot);
    if (slot && slot.status === "draft" && slotEditForm) {
      const values = slotInputValues(slot);
      slotEditForm.elements.slotId.value = slot.id;
      slotEditForm.elements.date.value = values.date;
      slotEditForm.elements.label.value = slot.label || "";
      slotEditForm.elements.startTime.value = values.startTime;
      slotEditForm.elements.endTime.value = values.endTime;
      slotEditForm.elements.depositAmount.value = (slot.depositAmountCents / 100).toFixed(2);
      slotEditDialog?.showModal();
    }
    return;
  }

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
