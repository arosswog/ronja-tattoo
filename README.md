# ronja-tattoo

Mobile-first Website für Ronja Tattoo mit:

- Landingpage im modernen Tattoo-Stil
- Galerie mit initialen Beispielmotiven
- Termin-Anfrageformular
- Admin-Setup, Login und Freigabe von Buchungsanfragen
- Bild-Uploads für die Galerie

## Starten

```bash
npm install
npm start
```

Danach läuft die Seite unter `http://localhost:3000`.

## Admin einrichten

1. `http://localhost:3000/admin` öffnen
2. Beim ersten Aufruf ein Passwort mit mindestens 10 Zeichen setzen
3. Danach mit dem Passwort anmelden

## Hinweise

- Uploads werden unter `storage/uploads` gespeichert.
- Buchungen und Galerie-Daten liegen in `data`.
- Nur JPG, PNG und WEBP werden für Uploads akzeptiert.

## Deployment auf Vercel

Das Projekt ist für Vercel vorbereitet:

- `vercel.json` leitet alle Anfragen an die Serverless-Function weiter.
- `api/index.js` stellt die Express-App als Serverless-Function bereit.
- Statische Dateien aus `public/` werden direkt über das Vercel-CDN ausgeliefert.

Deployen per Dashboard (Repository importieren) oder per CLI:

```bash
npm install -g vercel
vercel        # Vorschau-Deployment
vercel --prod # Produktions-Deployment
```

**Wichtiger Hinweis zur Persistenz:** Vercel-Serverless-Functions haben ein
schreibgeschütztes, kurzlebiges Dateisystem. Auf Vercel werden Buchungen,
Galerie-Daten und Uploads daher unter `/tmp` abgelegt und gehen nach Inaktivität
oder bei einem neuen Deployment verloren. Für dauerhafte Speicherung sollte ein
externer Dienst angebunden werden (z. B. eine Datenbank und ein Object-Storage
wie Vercel Blob oder S3).
