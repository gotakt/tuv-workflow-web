# TÜV Prüfstelle Pro

Verwaltungssystem für TÜV-Prüfstellen: Terminplanung, Fahrzeugverwaltung,
Mängelerfassung, Statistik und Prüfberichte aus einer React/Vite-Codebasis.

Diese Variante nutzt eine zentrale **MariaDB-Datenbank** über eine
**Express-API** in `server/index.js`. Die Browser-App spricht nicht direkt mit
der Datenbank, sondern ausschließlich über HTTP-Endpunkte unter `/api`

[![Version](https://img.shields.io/badge/version-1.0.0-blue)](CHANGELOG.md)
[![Tests](https://img.shields.io/badge/tests-passing-brightgreen)](#testing)
[![E2E](https://img.shields.io/badge/e2e-playwright-2EAD33)](#testing)
[![Restore](https://img.shields.io/badge/restore-drill%20w%C3%B6chentlich-0A7EA4)](docs/backup.md#4a-der-restore-weg-ist-automatisiert-gepr%C3%BCft)
[![Lint](https://img.shields.io/badge/eslint-0%20errors-brightgreen)](#testing)
[![TypeScript](https://img.shields.io/badge/typescript-graduell-blue)](#tech-stack)
[![Database](https://img.shields.io/badge/db-MariaDB-003545)](#tech-stack)
[![Deployment](https://img.shields.io/badge/deployment-on--premise-blueviolet)](#deployment)
[![License](https://img.shields.io/badge/license-MIT-blue)](#lizenz)

## Features

- **Tagesplan**: Timeline- und Tabellenansicht, Termin-Anlage, Statuswechsel
  und Workflow-Guard für "Bestanden".
- **Fahrzeuge**: CRUD-Verwaltung mit Hersteller-, Modell- und Typ-Auswahl,
  Suche, Filter und HU-Fälligkeitsanzeige.
- **Mängelerfassung**: StVZO-Katalog plus Freitextmodus, Kategorien
  OM/GM/EM/GfM und Sperre für "Bestanden" bei blockierenden Mängeln.
- **Statistik**: Bestandsquoten, Prüfervergleich, Mängel nach Kategorie,
  Top-Mängel und Zeitraumfilter.
- **Berichte**: Suchbare Prüfliste mit Vorschau und A4-PDF-Export über den
  Browser-Print-Dialog.
- **Mobile-tauglich**: Bedienbar ab 360 px Viewport mit Sidebar-Overlay und
  Touch-tauglichen Controls.
- **Zentrale Persistenz**: MariaDB speichert Daten serverseitig, mehrere
  Browser/Clients in der Prüfstelle arbeiten auf demselben Datenbestand.
- **On-Premise pro Kunde**: Jede Prüfstelle betreibt einen eigenen lokalen
  Server. Kundendaten verlassen die Werkstatt nie.

## Architektur in 30 Sekunden

```text
                Prüfstelle (lokales Netzwerk, ohne Internet betreibbar)

                ┌─────────────────────────────────────────┐
                │ Server-PC                               │
                │   docker compose up                     │
                │   ├── MariaDB           (Port 3306)     │
                │   └── Express-API       (Port 8787)     │
                └─────────────────────────────────────────┘
                              ▲
                              │ HTTP/JSON (/api)
                              │
              ┌───────────────┼──────────────┐
              │               │              │
        ┌─────┴────┐   ┌──────┴───┐   ┌──────┴───┐
        │ Empfang  │   │ Prüfer   │   │  Chef    │
        │ Browser  │   │ Browser  │   │ Browser  │
        └──────────┘   └──────────┘   └──────────┘
```

Die UI bleibt von SQL entkoppelt. `useDb` verwaltet React-State und ruft
`apiClient.ts` auf. Die Express-API prüft Login und Rollen, validiert zentrale
Workflow-Regeln, fuehrt SQL gegen MariaDB aus und baut das Schema beim Start
über versionierte Migrationen auf (Stammdaten-Seeds bleiben idempotent).

## Tech Stack

| Layer | Technologie | Zweck |
|---|---|---|
| Frontend | React 19, Vite 8 | SPA und Entwicklungsserver |
| Sprache | TypeScript für neue Module, JSX für Legacy-Views | Typsicherheit dort, wo Datenformen wichtig sind |
| API | Express 5, helmet, express-rate-limit, CORS, dotenv | HTTP-Schnittstelle zwischen Browser und DB, Security-Header und Rate-Limits |
| Auth | `node:crypto` (scrypt, HMAC-SHA256) | Login, Rollen und Token ohne Zusatz-Dependencies |
| Persistenz | MariaDB, `mariadb` Node.js Driver | Zentrale relationale Datenhaltung |
| Desktop-Wrapper | Tauri 2 | Desktop-Build aus derselben Frontend-Codebasis |
| Styling | Tailwind CSS 4 | Utility-first Styling |
| Animation | Framer Motion | UI-Transitions |
| Charts | Recharts | Statistikdiagramme |
| Tests | Vitest 4, React Testing Library | Unit-, Component-, Hook- und DB-Tests |
| E2E | Playwright | Journeys durch Browser, API und MariaDB ohne Mocks |
| Linting | ESLint 9 | Statische Codequalität |
| Container | Docker Compose | On-Premise-Deployment (MariaDB + API + Frontend in einem Befehl) |

## Getting Started

Es gibt zwei Wege das Projekt zu starten. **Docker Compose ist der empfohlene
Weg** — ein Befehl startet MariaDB und Express-API mit Binary-Logging für
Backups. Der manuelle Weg ist nur für Setups gedacht, in denen kein Docker
verfügbar ist.

### Variante A — Docker Compose (empfohlen)

#### Voraussetzungen

- Docker Desktop (Windows/Mac) oder Docker Engine (Linux)
- Node.js v18+ (nur für das Vite-Frontend)

#### Setup

```powershell
copy .env.example .env
```

`ADMIN_TOKEN` in der `.env` setzen — im Docker-Deployment läuft die API mit
`NODE_ENV=production` und **verweigert ohne Token absichtlich den Start**
(sonst wären die Admin-Endpunkte für jeden im LAN offen). Token erzeugen:

```powershell
# PowerShell
[Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }))
# bash/zsh
openssl rand -hex 32
```

Dann:

```powershell
docker compose up -d
```

Das startet MariaDB (Port 3306, nur localhost) und die Express-API
(Port 8787). Das Schema wird beim ersten Start über versionierte Migrationen
angelegt, Stammdaten und Default-Benutzer werden idempotent geseedet
(Zugangsdaten: siehe [Benutzer & Rollen](#benutzer--rollen)).

Frontend dazu starten:

```powershell
npm install
npm run dev
```

Die App ist unter `http://localhost:5173` erreichbar. Vite proxyt `/api` an
`http://127.0.0.1:8787`.

Demo-Daten laden (mit dem Token aus der `.env`):

```powershell
Invoke-RestMethod -Method Post -Headers @{ "X-Admin-Token" = "<ADMIN_TOKEN>" } http://localhost:8787/api/admin/demo
```

### Variante B — Manuelles Setup ohne Docker

#### Voraussetzungen

- Node.js v18+
- Laufender MariaDB-Server auf `127.0.0.1:3306`
- Optional: Rust für den Tauri-Desktop-Build

#### MariaDB einrichten

```sql
CREATE DATABASE IF NOT EXISTS tuv_workflow
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE USER IF NOT EXISTS 'tuv_app'@'localhost'
  IDENTIFIED BY 'tuv_app_pw';

GRANT ALL PRIVILEGES ON tuv_workflow.* TO 'tuv_app'@'localhost';
FLUSH PRIVILEGES;
```

`.env` erstellen (siehe `.env.example`), dann:

```powershell
npm install
npm run dev:api    # Terminal 1
npm run dev        # Terminal 2
```

Details stehen in [docs/mariadb-setup.md](docs/mariadb-setup.md).

### Production-Build (Frontend statisch)

```powershell
npm run build
```

Im On-Premise-Modell laeuft die gesamte Anwendung (MariaDB, API, Frontend) in
der Prüfstelle. Das statische Frontend kann über einen Webserver oder direkt
über die API ausgeliefert werden; `VITE_API_BASE_URL` muss zur erreichbaren
API zeigen.

## Deployment

Die Anwendung ist als **On-Premise-Lösung pro Prüfstelle** konzipiert. Jede
Werkstatt betreibt einen eigenen Server-PC im internen Netzwerk; Mitarbeiter
verbinden sich vom Empfang, von Prüfer-Geräten oder Chef-PCs über das LAN
mit der zentralen Instanz.

Vorteile dieses Modells:

- **Datenschutz**: Kundendaten verlassen die Werkstatt nicht.
- **Keine Cloud-Kosten** für den Betrieb.
- **Volle Kontrolle über Backups** (siehe [docs/backup.md](docs/backup.md)).
- **Internetausfall** beeintraechtigt den Betrieb nicht.

### Auslieferungspaket

Ein Kunde bekommt kein Repository, sondern ein versioniertes Paket:

```bash
./scripts/paket-bauen.sh          # -> dist-paket/tuv-pruefstelle-pro-v1.0.0.tar.gz
```

Darin: `docker-compose.yml`, das gebaute Frontend, die API, die Backup- und
Restore-Skripte, `INSTALLATION.md`, `SECURITY.md`, `docs/backup.md`, eine
`VERSION`-Datei mit Commit-Stand und `PRUEFSUMMEN.txt` über jede einzelne
Datei. Kein Frontend-Quellcode, keine Tests, keine Projektunterlagen.

Ein Tag `v*` baut dasselbe Paket in der CI, prüft es nach dem Auspacken
gegen die Prüfsummen und hängt es an ein GitHub-Release
(`.github/workflows/release.yml`). Das Release bleibt ein Entwurf, bis ein
Mensch es veröffentlicht.

Versionen und Migrationshinweise: [CHANGELOG.md](CHANGELOG.md).

### Backup und Wiederherstellung

```bash
./scripts/backup.sh                      # verschlüsselter Dump nach ./backups
./scripts/backup.sh --ziel /mnt/nas/tuv  # zweites Medium
./scripts/restore.sh                     # neuestes Backup zurückspielen
./scripts/restore.sh --ziel-db tuv_probe backups/taeglich/<datei>   # Probe
```

Der Restore prüft die Prüfsumme **vor** dem Überschreiben und danach, ob der
WF-01-Trigger wieder da ist — ein Dump ohne Trigger spielt sich fehlerfrei
ein und ließe die Datenbank ohne ihre Schutzschicht zurück.

Dass dieser Weg funktioniert, ist keine Behauptung: `restore-drill.sh` legt
ein Backup an, **löscht die Datenbank**, stellt sie wieder her und vergleicht
einen normalisierten Fingerabdruck — mit Gegenprobe, dass ein beschädigtes
Backup abgelehnt wird. Läuft wöchentlich in der CI. Details:
[docs/backup.md](docs/backup.md).

## Benutzer & Rollen

Die API kennt drei Rollen und legt beim ersten Start drei Default-Benutzer
an (Login per `POST /api/auth/login` mit `{ kuerzel, passwort }`):

| Kürzel | Name | Rolle |
|---|---|---|
| `empfang` | Empfang | empfang |
| `MW` | Marwan Saleh | pruefer |
| `chef` | Chef | chef |

Das Default-Passwort für alle drei ist der Wert von `DEFAULT_USER_PASSWORT`
aus der `.env` (Fallback: `start123`). **Beim Kunden-Setup müssen die
Passwörter geändert werden** — der Default greift nur beim Anlegen.

Rechte-Matrix (serverseitig durchgesetzt):

| Aktion | empfang | pruefer | chef |
|---|---|---|---|
| Lesen (alle GET-Endpunkte) | ✅ | ✅ | ✅ |
| Halter/Fahrzeuge/Termine anlegen + ändern | ✅ | ✅ | ✅ |
| Status setzen (`PATCH /api/termine/:id/status`) | ❌ | ✅ | ✅ |
| Mängel anlegen/löschen | ❌ | ✅ | ✅ |
| Halter/Fahrzeuge/Termine löschen | ❌ | ❌ | ✅ |
| `/api/admin/*` (zusätzlich `X-Admin-Token` nötig) | ❌ | ❌ | ✅ |

`AUTH_ENABLED` steuert, ob Login verlangt wird: Default **aus** in
Entwicklung/CI (alles läuft wie bisher, Requests laufen als Dev-Chef),
Default **an** bei `NODE_ENV=production`. `GET /api/auth/me` verrät dem
Frontend, ob Auth aktiv ist und welche Rolle der Token trägt.
Tokens sind HMAC-SHA256-signiert und 12 Stunden gültig; Passwörter werden
mit scrypt gehasht (beides `node:crypto`, keine Zusatz-Dependencies).

## Datenbank

Die physische MariaDB-Struktur entsteht über versionierte, append-only
Migrationen in `server/migrations.js` (protokolliert in `schema_migration`,
siehe ADR-011); Seeds und WF-01-Trigger wendet `server/db.js` bei jedem Start
idempotent an:

- `halter`
- `fahrzeug`
- `termin`
- `mangel`
- `status`
- `pruefart`
- `pruefer`
- `mangel_kategorie`
- `benutzer` (Login-Konten)
- `schema_migration` (Migrations-Protokoll)

Die wichtigsten Integritätsregeln liegen in MariaDB:

- Fremdschlüssel zwischen Halter, Fahrzeug, Termin und Mangel
- `ON DELETE CASCADE` für abhängige Termine und Mängel
- eindeutiges Kennzeichen und eindeutige FIN, soweit FIN gesetzt ist
- CHECK-Constraints für Baujahr und Kilometerstand
- Stammdatentabellen für Status, Prüfarten, Prüfer und Mangelkategorien

## Testing

```powershell
npm test            # Unit-, Component-, Hook- und Server-Tests (Vitest)
npm run test:watch
npm run e2e         # End-to-End im Browser (Playwright, startet API + Vite selbst)
npm run lint
npm run typecheck
npm run build
npm run restore-drill   # Backup → DROP DATABASE → Restore → Vergleich
```

### Drei Ebenen, drei verschiedene Fehlerklassen

| Ebene | Ort | Findet |
|---|---|---|
| Unit / Component / Flow | `src/tests/` | Logikfehler, kaputte Verdrahtung in der Oberfläche (gegen einen gemockten API-Client) |
| Server-Integration | `server/tests/` | API-Semantik, Rechte, Validierung, WF-01 gegen eine echte MariaDB |
| End-to-End | `e2e/` | Vertragsbrüche zwischen Frontend und API — die sieht keine der beiden anderen Ebenen |

Die E2E-Journeys decken ab: Anmeldung und Abmeldung, den Prüfablauf
(Termin → Mangel → Ergebnis mit WF-01), die Rollenrechte, Fahrzeug- und
Terminanlage, Berichte und Statistik sowie die Bedienung im Tablet-Viewport.
Sie laufen mit eingeschalteter Authentifizierung gegen eine eigene
Datenbank (`tuv_e2e`) und eigene Ports — ein laufender Entwicklungs-Server
wird nicht angefasst.

### Stand

- `npm run lint` (0 Fehler), `npm run typecheck` und `npm run build` laufen
  sauber.
- 256 Vitest-Tests; mit erreichbarer Datenbank laufen davon 254, zwei sind
  Platzhalter für den übersprungenen Fall.
- 24 Playwright-Journeys in zwei Projekten (Desktop-Chromium und
  Tablet-Viewport).
- **Alle drei WF-01-Verteidigungsschichten laufen in der CI** — auch die
  dritte, die rohes SQL an der API vorbei gegen den Datenbank-Trigger
  schickt. Sie war früher auf `docker exec` verdrahtet und in der Pipeline
  ausgenommen; `server/tests/dbCli.js` wählt den Zugriffsweg jetzt zur
  Laufzeit. Ein eigener CI-Schritt schlägt fehl, falls dieser Test doch
  einmal still übersprungen würde.
- Der Restore-Weg wird wöchentlich automatisiert geprüft
  (`.github/workflows/restore-drill.yml`) — inklusive Gegenprobe, dass ein
  beschädigtes Backup abgelehnt wird.
- Zusätzlich CodeQL und Dependabot.

Voraussetzung für die Server- und E2E-Tests ist eine erreichbare MariaDB:
`docker compose up -d db`, ein lokal installierter Server oder der
CI-Service.

## Projekt-Struktur

```text
server/
  db.js                 MariaDB-Pool, Stammdaten-Seeds und WF-01-Trigger
  migrations.js         Versionierte Schema-Migrationen (ADR-011)
  auth.js               Passwort-Hashing, Token, Rollen-Matrix
  validate.js           Serverseitige Eingabe-Validierung
  index.js              Express-API mit Auth-, CRUD- und Admin-Endpunkten
  tests/                Server-Tests (validate, auth, WF-01, Boot-Guard)

src/
  db/
    apiClient.ts        HTTP-Client für /api
    types.ts            TypeScript-Datentypen für die Frontend-Schicht
  hooks/
    useDb.ts            React-State-Hook über apiClient.ts (DB-Shape direkt)
  auth/                 AuthContext (Login-State, Token, useRechte)
  views/                Login, Tagesplan, Fahrzeuge, Statistik, Berichte
  features/             Modale für Fahrzeug, Termin und Mangel + Bericht-Generator
  constants/            Status, Prüfarten, Mängelkatalog, KFZ-Referenzen
  utils/                Validatoren und Datumsfunktionen
  tests/                Vitest-Tests (inkl. UI-Flow-Tests in tests/flows/)

e2e/                    Playwright-Journeys (echter Browser, echte API, echte DB)
  hilfen.js             Login, Demodaten, Zeilen-Selektoren

scripts/                Betriebs-Skripte
  backup.sh             verschlüsselter Dump mit Rotation
  restore.sh            Restore mit Prüfsummen- und Trigger-Kontrolle
  restore-drill.sh      Backup → DROP DATABASE → Restore → Vergleich
  paket-bauen.sh        Auslieferungspaket
  lib/db.sh             DB-Zugriff (Docker / Client / CI)

tools/                  Einmal-Werkzeuge, nicht Teil des Betriebs
docs/                   Projekt- und Abgabedokumentation
docs/decisions/         Architecture Decision Records
docs/praesentation/     Abschlusspräsentationen (Uni-Abgabe)
src-tauri/              Tauri/Rust-Desktop-Shell
.github/workflows/      CI/CD-Pipelines (ci, e2e, restore-drill, release, codeql)
```

Die aktive Persistenz liegt in `server/db.js`/`server/migrations.js` und
MariaDB.

## Dokumentation

| Datei | Inhalt |
|---|---|
| [CHANGELOG.md](CHANGELOG.md) | Versionen, Änderungen, Migrationshinweise |
| [SECURITY.md](SECURITY.md) | Bedrohungsmodell, Rechte, Geheimnisse — und die bekannten Grenzen |
| [docs/mariadb-setup.md](docs/mariadb-setup.md) | Lokales MariaDB-Setup (Docker und manuell) |
| [docs/backup.md](docs/backup.md) | 3-Tier-Backup-Strategie für On-Premise-Betrieb |
| [docs/design.md](docs/design.md) | Architektur, Schichten, Datenfluss und Deployment |
| [docs/datenmodell.md](docs/datenmodell.md) | ER-Modell, 3NF-Schema und physisches MariaDB-Modell |
| [docs/pflichtenheft.md](docs/pflichtenheft.md) | Anforderungen, Akzeptanzkriterien und Rahmenbedingungen |
| [docs/testkonzept.md](docs/testkonzept.md) | Teststrategie und manuelle Smoke-Tests |
| [docs/test-coverage.md](docs/test-coverage.md) | Coverage- und Restrisiko-Übersicht |
| [docs/backlog.md](docs/backlog.md) | Product Backlog und Sprint-Historie |
| [docs/quellen.md](docs/quellen.md) | Quellenverzeichnis |
| [docs/decisions/README.md](docs/decisions/README.md) | Architekturentscheidungen |

## Lizenz

MIT - Marwan Saleh, Oussama Hlayhel
