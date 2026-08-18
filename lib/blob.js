const crypto = require("crypto");

const { put, del } = require("@vercel/blob");

const allowedUploadTypes = new Map([
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
]);

// Uploads a gallery image buffer (from multer's memoryStorage) to Vercel
// Blob and returns its public URL. Replaces the old multer.diskStorage
// write into storage/uploads, which was silently lost on every Vercel
// cold start.
async function uploadGalleryImage(file) {
  const extension = allowedUploadTypes.get(file.mimetype) || ".bin";
  const filename = `gallery/${crypto.randomUUID()}${extension}`;

  const blob = await put(filename, file.buffer, {
    access: "public",
    contentType: file.mimetype,
  });

  return blob.url;
}

async function deleteGalleryImage(url) {
  await del(url);
}

module.exports = { uploadGalleryImage, deleteGalleryImage, allowedUploadTypes };
