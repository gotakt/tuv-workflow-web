# Sicherheit — TÜV Prüfstelle Pro

Stand: 2026-09-07 · gilt für Version 1.0.0

Dieses Dokument beschreibt, wogegen die Anwendung schützt, wie sie das tut
und — genauso wichtig — wogegen sie **nicht** schützt. Jede Aussage hier
lässt sich im Code nachlesen; die Fundstellen stehen dabei.

---

## 1. Bedrohungsmodell

Die Anwendung läuft **on-premise** auf einem Server-PC im Netz der
Prüfstelle. Sie ist nicht aus dem Internet erreichbar und braucht für den
Betrieb keine Internetverbindung.

Daraus folgt, was realistisch ist und was nicht:

| Szenario | Relevanz | Behandlung |
|---|---|---|
| Mitarbeiter setzt ein Prüfergebnis, das er nicht setzen darf | hoch | Rollen, serverseitig durchgesetzt (§ 3) |
| Prüfergebnis "Bestanden" trotz erheblichem Mangel | hoch | WF-01, drei Schichten (§ 4) |
| Jemand im Werkstatt-WLAN spricht die API direkt an | mittel | Login-Pflicht, Rollen, Rate-Limits (§ 3, § 6) |
| Datenverlust durch Defekt, Fehlbedienung, Ransomware | hoch | Backup + geprüfter Restore (§ 7) |
| Passwort-Raten am Login | mittel | scrypt, Rate-Limit 10/15 min (§ 2, § 6) |
| Angreifer mit physischem Zugang zum Server-PC | akzeptiert | nicht abgedeckt (§ 9) |
| Angriff aus dem Internet | gering | System ist nicht exponiert |

---

## 2. Authentifizierung

**Passwörter** (`server/auth.js`)

- scrypt, N=16384, r=8, p=1, 16-Byte-Salt, 64-Byte-Key
- Format `scrypt$N$r$p$salt$hash` — die Parameter stehen im Hash, sie lassen
  sich später erhöhen, ohne bestehende Konten ungültig zu machen
- Vergleich mit `timingSafeEqual`, nicht mit `===`
- Grenzwerte beim Parsen: ein manipulierter Datenbankwert kann scrypt nicht
  mit absurden Parametern als Speicher-Bombe starten

**Sitzungs-Token** (`server/auth.js`)

- HMAC-SHA256 über die Payload, base64url — JWT-ähnlich, aber **ohne
  Header-Segment**: der Algorithmus ist fest verdrahtet, ein
  `alg=none`-Downgrade ist konstruktionsbedingt unmöglich
- Gültigkeit 12 Stunden (`TOKEN_GUELTIGKEIT_MS`)
- Signaturvergleich timing-sicher
- Secret: `AUTH_SECRET`, ersatzweise `ADMIN_TOKEN`

**Fail-fast beim Start** (`server/index.js`)

- `NODE_ENV=production` ohne `ADMIN_TOKEN` → der Server **startet nicht**.
  Ohne Token wären `/api/admin/reset` und `/api/admin/demo` für jeden im LAN
  erreichbar; eine Warnung im Log hätte niemand gelesen.
- `AUTH_ENABLED=true` ohne Secret → der Server startet nicht. Mit leerem
  Secret wäre jeder Token fälschbar.

---

## 3. Autorisierung

Drei Rollen, passend zu den drei Arbeitsplätzen (`ROLLEN_RECHTE` in
`server/auth.js`):

| Aktion | empfang | pruefer | chef |
|---|---|---|---|
| Lesen | ✅ | ✅ | ✅ |
| Stammdaten/Termine anlegen und ändern | ✅ | ✅ | ✅ |
| Prüfergebnis setzen | ❌ | ✅ | ✅ |
| Mängel erfassen/entfernen | ❌ | ✅ | ✅ |
| Löschen | ❌ | ❌ | ✅ |
| `/api/admin/*` (zusätzlich `X-Admin-Token`) | ❌ | ❌ | ✅ |

Zwei Punkte, die den Unterschied machen:

1. **Durchgesetzt wird serverseitig.** Die Oberfläche blendet Aktionen aus,
   die eine Rolle nicht hat — das ist Bequemlichkeit, kein Schutz. Geprüft
   wird in `requireAuth(...)` vor jedem schreibenden Endpunkt. Die
   E2E-Tests belegen beides getrennt: dass die Schaltfläche fehlt *und*
   dass die API dieselbe Anfrage mit 403 ablehnt
   (`e2e/03-rollen.spec.js`).
2. **Fail-closed.** `darfSchreiben`/`darfStatusSetzen`/`darfLoeschen` liefern
   für unbekannte Rollen `false`. Eine neue Rolle bekommt keine Rechte, weil
   jemand vergessen hat, sie einzutragen.

---

## 4. Die fachliche Schutzregel (WF-01)

Ein Termin darf nicht auf "Bestanden" gesetzt werden, solange ein
unbehobener erheblicher (EM) oder gefährlicher (GfM) Mangel erfasst ist
(§ 29 StVZO). Diese Regel ist dreifach abgesichert:

| Schicht | Ort | Was sie abfängt |
|---|---|---|
| 1 — Oberfläche | `MaengelModal.jsx` | Fehlbedienung; Schaltfläche gesperrt mit Begründung |
| 2 — API | `PATCH /api/termine/:id/status` | Aufrufe an der Oberfläche vorbei |
| 3 — Datenbank | Trigger `trg_termin_wf01_update` | direktes SQL aus einem DB-Werkzeug |

Zusätzlich stuft der Server einen bereits bestandenen Termin selbst zurück,
wenn nachträglich ein blockierender Mangel erfasst wird (Auto-Demotion).

Jede Schicht wird einzeln geprüft — auch Schicht 3, die dafür rohes SQL an
der API vorbei schickt (`server/tests/wf01.test.js`, Layer 3). Dieser Test
lief früher nur auf einem laufenden Docker-Stack und war in der CI
ausgenommen; seit `server/tests/dbCli.js` läuft er in jeder Pipeline mit,
und ein eigener CI-Schritt schlägt fehl, wenn er still übersprungen würde.

---

## 5. Umgang mit Geheimnissen

- Alle Geheimnisse kommen aus `.env`; `.gitignore` schließt `.env` und
  `.env.*` aus, `\.env.example` enthält nur Platzhalter.
- Die Backup-Skripte reichen Datenbank-Passwörter **nie** als
  `-p<passwort>` auf der Kommandozeile weiter — dort läse sie jeder Benutzer
  des Server-PCs per `ps aux` mit. Stattdessen eine Option-Datei mit 0600,
  die beim Beenden gelöscht wird (`scripts/lib/db.sh`).
- Der Backup-Schlüssel gehört **nicht** auf den Server: ausgedruckt in den
  Tresor (`docs/backup.md` § 5). Ransomware, die den Server vollständig
  übernimmt, kann verschlüsselte Backups damit nicht entschlüsseln.
- Fehlermeldungen der API geben keine SQL-Details preis; Datenbankfehler
  werden auf HTTP-Semantik abgebildet (`server/index.js`, Error-Mapping).

---

## 6. Netzwerk und Transport

- **HTTP im LAN, kein HTTPS.** Bewusste Entscheidung: ein
  On-Premise-Deployment ohne Domain hat kein Zertifikat, und selbstsignierte
  Zertifikate erziehen Anwender dazu, Warnungen wegzuklicken.
  `upgrade-insecure-requests` ist in der CSP deshalb ausgeschaltet — sonst
  würden alle Requests auf ein nicht existierendes HTTPS umgeschrieben.
  **Konsequenz: wer im Werkstatt-WLAN mitliest, sieht Anmeldedaten.** Das
  Netz der Prüfstelle muss entsprechend abgesichert sein (WPA2/3, kein
  offenes Gäste-WLAN im selben Segment).
- Security-Header über `helmet` inklusive CSP. Inline-**Styles** sind
  erlaubt (die Oberfläche braucht `style={{…}}`), Inline-**Scripts** nicht.
- CORS erlaubt localhost und die privaten Netzbereiche nach RFC 1918;
  weitere Origins nur explizit über `ALLOWED_ORIGINS`.
- Rate-Limits (nur bei `NODE_ENV=production`, damit Integrationstests nicht
  anschlagen):
  - `/api` — 600 Anfragen/Minute
  - `/api/admin` — 30 pro 15 Minuten
  - `/api/auth/login` — 10 pro 15 Minuten
- MariaDB ist im Compose-Stack an `127.0.0.1` gebunden. Ein offener Port
  3306 im Werkstatt-WLAN wäre unnötige Angriffsfläche.

---

## 7. Daten und Backups

- Alle Daten liegen in MariaDB auf dem Server-PC der Prüfstelle. Es gibt
  **keinen** Cloud-Dienst und keinen Zugriff des Software-Anbieters auf
  Kundendaten.
- Backups: verschlüsselter Dump (AES-256-CBC, PBKDF2 mit 200 000 Runden),
  Rotation 7 täglich / 4 wöchentlich / 12 monatlich (`scripts/backup.sh`).
  Ohne gesetzten Schlüssel bricht das Skript ab, statt einen unverschlüsselten
  Dump mit Kundendaten zu schreiben.
- Der Restore prüft die Prüfsumme **vor** dem Überschreiben und danach, ob
  der WF-01-Trigger wieder vorhanden ist. Ein Dump ohne Trigger spielt sich
  fehlerfrei ein und ließe die Datenbank ohne ihre Schutzschicht zurück.
- **Der Restore-Weg ist automatisiert getestet**, nicht nur beschrieben:
  `.github/workflows/restore-drill.yml` legt wöchentlich eine Datenbank an,
  sichert sie, löscht sie mit `DROP DATABASE`, stellt sie wieder her und
  vergleicht einen normalisierten Fingerabdruck. Die Gegenprobe mit einem
  absichtlich beschädigten Backup muss dabei scheitern.

---

## 8. Abhängigkeiten und Codeprüfung

- CodeQL (JavaScript/TypeScript) bei jedem Push und wöchentlich
  (`.github/workflows/codeql.yml`).
- Dependabot für npm-Pakete und GitHub Actions
  (`.github/dependabot.yml`).
- Laufzeit-Abhängigkeiten sind bewusst knapp gehalten: Authentifizierung und
  Token laufen über `node:crypto`, ohne zusätzliche Bibliothek.
- Secret Scanning mit Push Protection ist in den Repository-Einstellungen zu
  aktivieren (Settings → Code security). Das lässt sich nicht im Repository
  hinterlegen und steht deshalb hier als Betriebsschritt, nicht als
  erledigte Zusage.

---

## 9. Bekannte Grenzen

Ehrlicher Teil. Diese Punkte sind bekannt und bewusst offen:

1. **Kein HTTPS im LAN** (§ 6). Anmeldedaten sind für Mitlesende im selben
   Netz sichtbar.
2. **Kein physischer Schutz.** Wer Zugang zum Server-PC hat, hat Zugang zur
   Datenbank. Festplattenverschlüsselung ist Aufgabe des Betreibers.
3. **Keine Token-Rücknahme.** Ein ausgegebener Token bleibt bis zu 12 Stunden
   gültig, auch wenn das Konto gesperrt wird. Für einen Betrieb mit drei
   Arbeitsplätzen vertretbar, für größere Installationen nicht.
4. **Kein Änderungsprotokoll (Audit-Log).** Es ist nicht nachvollziehbar, wer
   ein Prüfergebnis gesetzt hat. Für eine Prüforganisation mit
   Nachweispflicht wäre das nachzurüsten.
5. **Keine Passwortrichtlinie und keine Zwei-Faktor-Anmeldung.** Das
   Startpasswort aus `DEFAULT_USER_PASSWORT` greift nur beim Anlegen der
   Konten; ob es geändert wird, erzwingt die Anwendung nicht.
6. **Ein gemeinsamer Admin-Token** statt persönlicher Administratorkonten für
   `/api/admin/*`.
7. **Kein Schutz gegen einen böswilligen Prüfer.** Wer die Rolle hat, darf
   Mängel entfernen und danach "Bestanden" setzen. Dagegen hilft nur ein
   Audit-Log (Punkt 4), keine technische Sperre.

---

## 10. Sicherheitsproblem melden

Bitte **kein** öffentliches GitHub-Issue eröffnen. Meldung an den
Repository-Inhaber über die GitHub-Funktion „Report a vulnerability" oder
per E-Mail. Ich melde mich innerhalb von 7 Tagen zurück.

Hilfreich in der Meldung: betroffene Version (`VERSION` im
Auslieferungspaket), Schritte zum Nachvollziehen, tatsächliche und erwartete
Wirkung.
