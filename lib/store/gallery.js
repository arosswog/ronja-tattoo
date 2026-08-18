const { query } = require("../db");

function toGalleryEntry(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    tags: row.tags,
    image: row.image,
    createdAt: row.created_at.toISOString(),
  };
}

async function listGallery() {
  const { rows } = await query(
    "SELECT id, title, description, tags, image, created_at FROM gallery_entries ORDER BY created_at DESC"
  );
  return rows.map(toGalleryEntry);
}

async function createGalleryEntry({ title, description, tags, image }) {
  const { rows } = await query(
    `INSERT INTO gallery_entries (title, description, tags, image)
     VALUES ($1, $2, $3, $4)
     RETURNING id, title, description, tags, image, created_at`,
    [title, description, tags, image]
  );
  return toGalleryEntry(rows[0]);
}

async function getGalleryEntry(id) {
  const { rows } = await query(
    "SELECT id, title, description, tags, image, created_at FROM gallery_entries WHERE id = $1",
    [id]
  );
  return rows[0] ? toGalleryEntry(rows[0]) : null;
}

async function deleteGalleryEntry(id) {
  const { rowCount } = await query("DELETE FROM gallery_entries WHERE id = $1", [id]);
  return rowCount > 0;
}

module.exports = { listGallery, createGalleryEntry, getGalleryEntry, deleteGalleryEntry };
