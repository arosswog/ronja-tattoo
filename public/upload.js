// Shared client-side upload helper.
//
// Why this exists: Vercel rejects serverless request bodies larger than
// ~4.5 MB with a plain-text "413 Request Entity Too Large" — no JSON. The
// admin/booking code did `await response.json()` on that, which throws in
// every browser and surfaces as Safari's cryptic
// "The string did not match the expected pattern."
//
// So: shrink photos in the browser before upload, and never assume the
// response is JSON.
(function () {
  // Stay safely below Vercel's ~4.5 MB function request body cap.
  var MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
  // Images already this small are uploaded untouched.
  var SKIP_BELOW_BYTES = 800 * 1024;
  var SKIPPED_TYPES = ["image/gif", "image/svg+xml"];

  function isImage(file) {
    return Boolean(file && file.type && file.type.indexOf("image/") === 0);
  }

  function loadBitmap(file) {
    if (typeof createImageBitmap === "function") {
      return createImageBitmap(file);
    }
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error("Bild konnte nicht gelesen werden."));
      };
      img.src = url;
    });
  }

  function draw(bitmap, maxEdge, quality) {
    var width = bitmap.width || bitmap.naturalWidth;
    var height = bitmap.height || bitmap.naturalHeight;
    var scale = Math.min(1, maxEdge / Math.max(width, height));
    var canvas = document.createElement("canvas");
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return new Promise(function (resolve) {
      canvas.toBlob(resolve, "image/jpeg", quality);
    });
  }

  function jpegName(name) {
    var base = String(name || "bild").replace(/\.[^./\\]+$/, "");
    return (base || "bild") + ".jpg";
  }

  // Returns { blob, name, changed }. Never throws for "cannot compress" —
  // we simply upload the original in that case.
  async function prepare(file) {
    if (!isImage(file) || SKIPPED_TYPES.indexOf(file.type) !== -1) {
      return { blob: file, name: file.name, changed: false };
    }
    if (file.size <= SKIP_BELOW_BYTES) {
      return { blob: file, name: file.name, changed: false };
    }

    var attempts = [
      { maxEdge: 2000, quality: 0.85 },
      { maxEdge: 1600, quality: 0.8 },
      { maxEdge: 1200, quality: 0.75 },
    ];

    try {
      var bitmap = await loadBitmap(file);
      for (var i = 0; i < attempts.length; i++) {
        var blob = await draw(bitmap, attempts[i].maxEdge, attempts[i].quality);
        if (!blob) continue;
        if (blob.size < file.size || i === attempts.length - 1) {
          return {
            blob: blob,
            name: jpegName(file.name),
            changed: blob.size < file.size,
          };
        }
      }
    } catch (error) {
      // Fall through: upload untouched, let the server/platform decide.
    }

    return { blob: file, name: file.name, changed: false };
  }

  // Prepare one or many files; returns an array of { blob, name }.
  async function prepareAll(files) {
    var list = Array.prototype.slice.call(files || []);
    var out = [];
    for (var i = 0; i < list.length; i++) {
      out.push(await prepare(list[i]));
    }
    return out;
  }

  function tooLargeError() {
    return new Error(
      "Das Bild ist zu groß zum Hochladen. Bitte wähle ein kleineres Bild oder mach einen Screenshot davon."
    );
  }

  function assertSize(prepared) {
    if (prepared && prepared.blob && prepared.blob.size > MAX_UPLOAD_BYTES) {
      throw tooLargeError();
    }
  }

  // Reads a response that may be JSON, plain text (e.g. Vercel's 413 page) or
  // empty — returns parsed JSON, or throws a German, human-readable error.
  async function readJson(response) {
    var text = "";
    try {
      text = await response.text();
    } catch (error) {
      text = "";
    }

    var data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (error) {
        data = null;
      }
    }

    if (data && typeof data === "object") {
      if (!response.ok && data.error) {
        throw new Error(data.error);
      }
      if (!response.ok) {
        throw new Error("Der Server hat mit Status " + response.status + " geantwortet.");
      }
      return data;
    }

    if (!response.ok) {
      if (response.status === 413) throw tooLargeError();
      throw new Error("Der Server hat unerwartet geantwortet (" + response.status + "). Bitte versuch es nochmal.");
    }

    // 2xx but not JSON — treat as success without a payload.
    return {};
  }

  window.RonjaUpload = {
    MAX_UPLOAD_BYTES: MAX_UPLOAD_BYTES,
    prepare: prepare,
    prepareAll: prepareAll,
    assertSize: assertSize,
    tooLargeError: tooLargeError,
    readJson: readJson,
  };
})();
