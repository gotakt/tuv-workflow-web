# Änderungsprotokoll

Format nach [Keep a Changelog](https://keepachangelog.com/de/1.1.0/),
Versionierung nach [Semantic Versioning](https://semver.org/lang/de/).

Für Betreiber wichtig: Abschnitte **Migration** und **Bekannte Grenzen**
stehen bei jeder Version dabei. Ein Änderungsprotokoll, das nur auflistet,
was neu ist, hilft beim Aktualisieren nicht.

---

## [Unveröffentlicht]

Noch keine Änderungen seit 1.0.0.

---

## [1.0.0] — 2026-09-07

Erste als Produkt ausgelieferte Version. Die Anwendung selbst ist seit April
2026 gewachsen (188 Commits); mit dieser Version bekommt sie eine
Versionsnummer, ein Auslieferungspaket und einen automatisiert geprüften
Wiederherstellungsweg.

### Hinzugefügt

- **End-to-End-Tests** (`e2e/`, Playwright): sechs Journeys durch echten
  Browser, echtes Frontend, echte API und echte MariaDB — Anmeldung,
  Prüfablauf, Rollenrechte, Stammdaten, Berichte/Statistik und Bedienung mit
  Tablet-Viewport. Laufen in der CI mit (`.github/workflows/ci.yml`).
- **Restore-Drill** (`scripts/restore-drill.sh`,
  `.github/workflows/restore-drill.yml`): Backup schreiben, Datenbank per
  `DROP DATABASE` zerstören, wiederherstellen, normalisierten Fingerabdruck
  vergleichen. Inklusive Gegenprobe, dass ein beschädigtes Backup abgelehnt
  wird. Läuft wöchentlich und bei jeder Änderung an den Skripten.
- **Backup- und Restore-Werkzeuge** (`scripts/backup.sh`,
  `scripts/restore.sh`): verschlüsselter Dump (AES-256, PBKDF2), Rotation
  7/4/12, Prüfsummen-Kontrolle vor dem Einspielen, Trigger-Kontrolle danach.
  Damit sind die offenen Punkte aus `docs/backup.md` § 7 umgesetzt.
- **Auslieferungspaket** (`scripts/paket-bauen.sh`): versioniertes Archiv mit
  Compose-Datei, gebautem Frontend, API, Backup-Werkzeugen, `INSTALLATION.md`
  und Prüfsummen über jede Datei — ohne Quellcode, Tests und
  Projektunterlagen.
- **`SECURITY.md`**: Bedrohungsmodell, Authentifizierung, Rechte, Umgang mit
  Geheimnissen, Netzwerk, Backups — und ein Abschnitt mit den bekannten
  Grenzen.
- **Dependabot** (`.github/dependabot.yml`) für npm-Pakete und
  GitHub-Actions.
- **Release-Workflow** (`.github/workflows/release.yml`): baut auf einen
  Tag `v*` das Auslieferungspaket, prüft es und hängt es an ein
  GitHub-Release.
- **Audit-Schranke in CI und Release**: `npm audit --omit=dev
  --audit-level=high`. Bewusst nur Produktions-Abhängigkeiten und erst ab
  "high" — ein Fund in einem Build-Werkzeug landet nie beim Kunden, und eine
  Schranke, die an solchen Meldungen scheitert, wird irgendwann umgangen.

### Geändert

- **Der WF-01-Layer-3-Test läuft jetzt in der CI.** Er schickt rohes SQL an
  der API vorbei gegen den Datenbank-Trigger und war bisher fest auf
  `docker exec` verdrahtet — in der Pipeline gab es keinen solchen Container,
  also wurde er dort übersprungen (`TUV_SKIP_SQL_BYPASS`). `server/tests/dbCli.js`
  wählt den Zugriffsweg nun zur Laufzeit. Ein eigener CI-Schritt schlägt fehl,
  falls der Test doch einmal still übersprungen würde.
- **Laufzeit auf Node 24 (Active LTS).** Das Kunden-Deployment lief auf
  `node:20-alpine`; Node 20 ist seit dem 30.04.2026 End-of-Life und bekommt
  keine Sicherheitsfixes mehr. Docker-Image, alle CI-Workflows und die
  Dokumentation stehen jetzt auf Node 24, `engines.node` verlangt mindestens
  Node 22 (Maintenance LTS bis 04/2027).
- **Abhängigkeiten aktualisiert**: `npm audit` meldete 11 Schwachstellen,
  davon 4 in Produktions-Abhängigkeiten (2× high). Betroffen war unter
  anderem der MariaDB-Treiber selbst (3.5.2 → 3.5.4), nicht nur
  Build-Werkzeuge. Alle Korrekturen lagen innerhalb der bestehenden
  Semver-Bereiche, `package.json` blieb unverändert. Danach 0 Funde.
- `src-tauri`: Version auf 1.0.0, Repository-URL auf das umbenannte
  GitHub-Konto (`gotakt`) korrigiert.
- `docker-compose.yml`: Der Kopfkommentar nannte Port 5173 als Zugang für
  Mitarbeiter. Das stimmte nicht — beim Kunden liefert die API das gebaute
  Frontend unter 8787 mit aus, 5173 ist der Entwicklungsserver.

### Bekannte Grenzen

Vollständig in `SECURITY.md` § 9. Die wichtigsten:

- Kein HTTPS im LAN — Anmeldedaten sind für Mitlesende im selben Netz
  sichtbar. Das Netz der Prüfstelle muss abgesichert sein.
- Kein Änderungsprotokoll: es ist nicht nachvollziehbar, wer ein
  Prüfergebnis gesetzt hat.
- Keine Token-Rücknahme; ein ausgegebener Token gilt bis zu 12 Stunden.
- Keine Passwortrichtlinie und keine Zwei-Faktor-Anmeldung.

### Migration

Keine — 1.0.0 ist die erste ausgelieferte Version. Für Installationen, die
bereits aus dem Repository betrieben werden:

1. Backup ziehen: `./scripts/backup.sh`
2. `docker compose down`
3. Neues Paket auspacken, bestehende `.env` übernehmen
4. `docker compose up -d` — die Schema-Migrationen laufen beim Start selbst
   und sind append-only (ADR-011); ein Downgrade auf einen älteren Stand ist
   nicht vorgesehen.

---

[Unveröffentlicht]: https://github.com/gotakt/tuv-workflow-web/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/gotakt/tuv-workflow-web/releases/tag/v1.0.0
