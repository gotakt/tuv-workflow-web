# MariaDB-Setup

Diese Anleitung beschreibt den aktuellen Stand des Projekts: React/Vite im
Frontend, Express als API und MariaDB als zentrale Datenbank.

## 1. Architektur

```text
Browser
  -> React/Vite App
  -> src/db/apiClient.ts
  -> Express API (server/index.js)
  -> MariaDB Pool (server/db.js)
  -> MariaDB Datenbank tuv_workflow
```

Der Browser spricht niemals direkt mit MariaDB. Dadurch bleiben Datenbankhost,
Benutzer und Passwort im Backend.

## 2. Setup-Variante wählen

Es gibt zwei Wege MariaDB bereitzustellen:

| Variante | Vorteile | Wann nutzen? |
|---|---|---|
| **A — Docker Compose** | 1 Befehl, Binlog-Backup vorkonfiguriert, identisch in Dev/Prod | Standard, empfohlen |
| **B — Manuelles MariaDB** | Kein Docker nötig | Wenn Docker nicht installierbar ist |

### Variante A — Docker Compose (empfohlen)

#### Voraussetzungen

- Docker Desktop (Windows/Mac) oder Docker Engine (Linux)
- Node.js v18+ für das Vite-Frontend

#### Start

```powershell
copy .env.example .env
docker compose up -d
```

Damit laufen MariaDB (Port 3306, nur an 127.0.0.1 gebunden) und Express-API
(Port 8787). Die API legt die Datenbank beim ersten Start automatisch an und
baut das Schema über versionierte Migrationen auf (`server/migrations.js`,
protokolliert in der Tabelle `schema_migration`, siehe ADR-011); Stammdaten
und Default-Benutzer werden bei jedem Start idempotent nachgezogen. Binary
Logging ist aktiviert (siehe [backup.md](backup.md)).

Hinweis: Im Docker-Deployment läuft die API mit `NODE_ENV=production` — ohne
gesetzten `ADMIN_TOKEN` in der `.env` verweigert sie absichtlich den Start.

Prüfen:

```powershell
docker compose ps
docker compose logs -f api
Invoke-RestMethod http://localhost:8787/api/health
```

Stoppen:

```powershell
docker compose down            # Container weg, Daten bleiben im Volume
docker compose down -v         # ACHTUNG: löscht auch das Daten-Volume
```

### Variante B — Manuelles MariaDB

#### Voraussetzungen

- Node.js und npm
- MariaDB Server lokal installiert
- Projektabhängigkeiten aus `package-lock.json`

#### Datenbank und Benutzer anlegen

In MariaDB als Admin ausführen:

```sql
CREATE DATABASE IF NOT EXISTS tuv_workflow
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE USER IF NOT EXISTS 'tuv_app'@'localhost'
  IDENTIFIED BY 'tuv_app_pw';

GRANT ALL PRIVILEGES ON tuv_workflow.* TO 'tuv_app'@'localhost';
FLUSH PRIVILEGES;
```

Falls MariaDB nicht auf demselben Rechner wie die API laeuft, muss der Host im
User passend gesetzt werden, zum Beispiel `'tuv_app'@'%'` oder ein konkreter
Servername.

#### macOS mit Homebrew

Auf einem Entwickler-Mac ohne Docker ist das der schnellste Weg zu einer
Datenbank, gegen die Server-Tests, E2E-Tests und der Restore-Drill laufen
koennen:

```bash
brew install mariadb
brew services start mariadb          # startet MariaDB dauerhaft

mariadb -u root <<'SQL'
CREATE DATABASE IF NOT EXISTS tuv_workflow
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'tuv_app'@'127.0.0.1' IDENTIFIED BY 'tuv_app_pw';
CREATE USER IF NOT EXISTS 'tuv_app'@'localhost' IDENTIFIED BY 'tuv_app_pw';
GRANT ALL PRIVILEGES ON *.* TO 'tuv_app'@'127.0.0.1';
GRANT ALL PRIVILEGES ON *.* TO 'tuv_app'@'localhost';
FLUSH PRIVILEGES;
SQL
```

`GRANT ALL ON *.*` statt nur auf `tuv_workflow.*`: der Restore-Drill legt
Wegwerf-Datenbanken an und loescht sie wieder (`tuv_drill`, `tuv_e2e`).
Auf einem Entwickler-Rechner ist das in Ordnung — **beim Kunden nicht**.
Dort hat der Anwendungsbenutzer bewusst nur Rechte auf seiner eigenen
Datenbank, und Backup/Restore laufen ueber `MARIADB_ROOT_PASSWORD`.

Binary-Logging ist bei einer Homebrew-Installation standardmaessig aus.
Fuer Point-in-Time-Recovery (docs/backup.md, Tier 1) muesste es in
`/opt/homebrew/etc/my.cnf` eingeschaltet werden; fuer Tests wird es nicht
gebraucht.

Wieder abschalten: `brew services stop mariadb`.

## 4. Environment

Lokale Datei `.env` im Projektordner:

```text
MARIADB_HOST=127.0.0.1
MARIADB_PORT=3306
MARIADB_USER=tuv_app
MARIADB_PASSWORD=tuv_app_pw
MARIADB_DATABASE=tuv_workflow
API_PORT=8787
VITE_API_BASE_URL=/api
```

Dazu kommen die Sicherheits-Variablen `NODE_ENV`, `ADMIN_TOKEN`,
`AUTH_ENABLED`, `AUTH_SECRET` und `DEFAULT_USER_PASSWORT` — Bedeutung und
Beispiele stehen kommentiert in `.env.example`.

`.env` wird nicht committet. Die Vorlage liegt in `.env.example`.

## 5. Lokal starten

Terminal 1, API:

```powershell
cd C:\Users\user\tuv-workflow-web
npm run dev:api
```

Terminal 2, Frontend:

```powershell
cd C:\Users\user\tuv-workflow-web
npm run dev
```

Die App ist lokal unter `http://localhost:5173` erreichbar. Vite leitet `/api`
an `http://127.0.0.1:8787` weiter (Ziel überschreibbar via
`VITE_API_PROXY_TARGET`).

### Login

In Produktion (bzw. mit `AUTH_ENABLED=true`) verlangt die App einen Login.
Beim ersten Start werden drei Default-Benutzer angelegt: `empfang` (Rolle
empfang), `MW` (pruefer) und `chef` (chef). Das gemeinsame Default-Passwort
ist der Wert von `DEFAULT_USER_PASSWORT` aus der `.env` (Fallback:
`start123`) — **beim Kunden-Setup müssen die Passwörter geändert werden**.
In development/CI ist die Auth per Default aus; die Requests laufen dann
ohne Login.

## 6. Demo-Daten laden

Der Demo-Endpunkt löscht die lokalen Fachdaten und legt den Demo-Stand neu an.
Wenn `ADMIN_TOKEN` gesetzt ist (im Docker-Deployment Pflicht), muss er als
`X-Admin-Token`-Header mitgeschickt werden:

```powershell
# Dev-Modus (NODE_ENV=development, kein ADMIN_TOKEN):
Invoke-RestMethod -Method Post http://127.0.0.1:8787/api/admin/demo

# Mit gesetztem ADMIN_TOKEN:
Invoke-RestMethod -Method Post -Headers @{ "X-Admin-Token" = "<ADMIN_TOKEN>" } http://127.0.0.1:8787/api/admin/demo
```

Erwartete Antwort:

```text
ok        : True
halter    : 8
fahrzeuge : 8
termine   : 13
maengel   : 12
```

## 7. Prüfen

API erreichbar:

```powershell
Invoke-RestMethod http://127.0.0.1:8787/api/health
Invoke-RestMethod http://127.0.0.1:8787/api/fahrzeuge
```

Direkt in MariaDB:

```sql
USE tuv_workflow;
SHOW TABLES;
SELECT COUNT(*) FROM halter;
SELECT COUNT(*) FROM fahrzeug;
SELECT COUNT(*) FROM termin;
SELECT COUNT(*) FROM mangel;
```

## 8. Tabellen

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

Die Tabellen entstehen beim API-Start über versionierte Migrationen in
`server/migrations.js` (ADR-011); Stammdaten, Default-Benutzer und der
WF-01-Trigger werden von `server/db.js` idempotent angelegt. Fachliche CRUD-,
Auth- und Demo-Endpunkte liegen in `server/index.js`.

## 9. Deployment-Hinweis

Die Anwendung wird **On-Premise pro Prüfstelle** ausgeliefert. Jeder Kunde
betreibt einen eigenen Server-PC mit Docker Compose im lokalen Netzwerk.
Mehrere Mitarbeiter-Geräte im LAN sehen denselben Datenstand, weil sie alle
dieselbe Server-Instanz nutzen. Backup-Konzept: [backup.md](backup.md).
