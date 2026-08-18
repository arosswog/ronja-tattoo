// Repeatable seed data — unlike migrations (which run exactly once per
// file), this is safe and expected to run every time (idempotent: only
// inserts when the table is empty). Called after `npm run migrate` and
// after every test-suite reset.

const { query } = require("./db");

const DEFAULT_GALLERY = [
  {
    title: "Ornamental Flow",
    description: "Elegante Linien mit weicher Bewegung und ornamentalem Fokus.",
    tags: ["ornamental", "fine line"],
    image: "/assets/gallery/ornamental-flow.svg",
    createdAt: "2026-01-12T10:00:00.000Z",
  },
  {
    title: "Botanical Lines",
    description: "Florale Fine-Line-Ästhetik mit leichter, moderner Komposition.",
    tags: ["floral", "minimal"],
    image: "/assets/gallery/botanical-lines.svg",
    createdAt: "2026-02-20T14:30:00.000Z",
  },
  {
    title: "Celestial Script",
    description: "Leichtes Lettering mit feinen Stern- und Sparkle-Details.",
    tags: ["lettering", "celestial"],
    image: "/assets/gallery/celestial-script.svg",
    createdAt: "2026-03-18T16:45:00.000Z",
  },
];

async function seedGallery() {
  const { rows } = await query("SELECT COUNT(*)::int AS count FROM gallery_entries");
  if (rows[0].count > 0) {
    return;
  }

  for (const entry of DEFAULT_GALLERY) {
    await query(
      `INSERT INTO gallery_entries (title, description, tags, image, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [entry.title, entry.description, entry.tags, entry.image, entry.createdAt]
    );
  }
}

async function seedAll() {
  await seedGallery();
}

if (require.main === module) {
  seedAll()
    .then(() => console.log("Seed data applied."))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}

module.exports = { seedAll, seedGallery, DEFAULT_GALLERY };
