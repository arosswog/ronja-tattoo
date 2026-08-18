# ronja-tattoo

Mobile-first Website für Ronja Tattoo mit:

- Landingpage im modernen Tattoo-Stil
- Galerie mit initialen Beispielmotiven
- Termin-Anfrageformular
- Admin-Setup, Login und Freigabe von Buchungsanfragen
- Bild-Uploads für die Galerie

Daten liegen in **Neon Postgres** (via Vercel-Integration), Galerie-Bilder in
**Vercel Blob** — beides persistent, kein Datenverlust mehr bei Redeploys oder
Cold Starts (siehe „Persistenz" weiter unten).

## Starten (lokal)

```bash
npm install
vercel env pull .env.local   # einmalig, holt POSTGRES_URL/BLOB_READ_WRITE_TOKEN etc.
npm run migrate              # legt Tabellen an + seedet die Beispiel-Galerie
npm run dev
```

Danach läuft die Seite unter `http://localhost:3000`.

`npm run dev`/`npm test`/`npm run migrate` laden `.env.local` automatisch
(`node --env-file`). `.env.local` wird von Vercel generiert und ist
gitignored — niemals committen.

## Admin einrichten

1. `http://localhost:3000/admin` öffnen
2. Beim ersten Aufruf ein Passwort mit mindestens 10 Zeichen setzen
3. Danach mit dem Passwort anmelden

## Umgebungsvariablen

| Variable | Zweck | Quelle |
|---|---|---|
| `POSTGRES_URL` | Datenbankverbindung (gepoolt, für die App) | Vercel-Neon-Integration, automatisch gesetzt |
| `BLOB_READ_WRITE_TOKEN` | Galerie-Bild-Uploads | Vercel-Blob-Integration, automatisch gesetzt |

Beide werden von Vercel automatisch in jede Umgebung (Development/Preview/
Production) injiziert, sobald die Integrationen im Projekt verbunden sind
(`vercel integration add neon`, `vercel blob create-store`). Für lokale
Entwicklung einmalig `vercel env pull .env.local` ausführen.

## Datenbank-Migrationen

Schema liegt als reine SQL-Dateien unter `migrations/`, angewendet über einen
kleinen eigenen Runner (`lib/migrate.js`) — kein ORM.

```bash
npm run migrate        # lokal, gegen .env.local
npm run migrate:prod   # gegen die Umgebung, für die echte Env-Vars gesetzt sind
```

Neue Migration hinzufügen: `migrations/00X_beschreibung.sql` anlegen (fortlaufend
nummeriert), danach `npm run migrate` — bereits angewendete Dateien werden
übersprungen (Tracking in der Tabelle `schema_migrations`).

## Hinweise

- Galerie-Bilder werden bei Upload nach Vercel Blob hochgeladen (öffentliche
  URL), nicht mehr lokal gespeichert.
- Nur JPG, PNG und WEBP werden für Uploads akzeptiert.

## Deployment auf Vercel

Das Projekt ist für Vercel vorbereitet:

- `vercel.json` leitet alle Anfragen an die Serverless-Function weiter.
- `api/index.js` stellt die Express-App als Serverless-Function bereit.
- Statische Dateien aus `public/` werden über Express ausgeliefert.

Deployen per Dashboard (Repository importieren) oder per CLI:

```bash
npm install -g vercel
vercel        # Vorschau-Deployment
vercel --prod # Produktions-Deployment
```

Nach dem ersten Deploy (oder nach neuen Migrationsdateien) einmal
`npm run migrate:prod` mit den Produktions-Env-Vars ausführen, damit das
Schema aktuell ist.

## Persistenz

Vercel-Serverless-Functions haben ein schreibgeschütztes, kurzlebiges
Dateisystem — frühere Versionen dieses Projekts legten Buchungen, Galerie-Daten
und Uploads deshalb unter `/tmp` ab und verloren sie bei jedem Cold Start oder
Redeploy. Das ist behoben: alle Daten liegen jetzt in Neon Postgres, Bilder in
Vercel Blob — beides überlebt Redeploys, Cold Starts und parallele
Serverless-Instanzen.
