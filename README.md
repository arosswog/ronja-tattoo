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
