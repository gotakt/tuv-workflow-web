#!/usr/bin/env bash
#
# Baut das Auslieferungspaket fuer eine Prüfstelle.
#
#   ./scripts/paket-bauen.sh              # Version aus package.json
#   ./scripts/paket-bauen.sh v1.1.0       # Version explizit
#
# Ergebnis: dist-paket/tuv-pruefstelle-pro-<version>.tar.gz + .sha256
#
# Inhalt ist genau das, was auf dem Server-PC der Werkstatt gebraucht wird —
# kein Quellcode des Frontends, keine Tests, keine Uni-Unterlagen. Wer ein
# Paket auspackt, soll sehen, was er betreibt, und nicht erst sortieren
# muessen, was davon zur Anwendung gehoert.

set -euo pipefail

SKRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WURZEL="$(cd "$SKRIPT_DIR/.." && pwd)"
cd "$WURZEL"

VERSION="${1:-v$(node -p "require('./package.json').version")}"
VERSION="${VERSION#v}"
NAME="tuv-pruefstelle-pro-v${VERSION}"
AUSGABE="$WURZEL/dist-paket"

echo "TÜV Prüfstelle Pro — Auslieferungspaket"
echo "  Version: $VERSION"

# Das Frontend muss gebaut sein: docker-compose.yml mountet dist/ in die API,
# die es dann mit ausliefert. Ohne diesen Schritt bekaeme der Kunde ein Paket,
# das nur die API startet und im Browser eine leere Seite zeigt.
echo "  -> Frontend bauen ..."
npm run build > /dev/null

BAU="$(mktemp -d)"
trap 'rm -rf "$BAU"' EXIT
ZIEL="$BAU/$NAME"
mkdir -p "$ZIEL"

kopieren() {
  local pfad="$1"
  [ -e "$pfad" ] || { echo "FEHLER: fehlt im Repository: $pfad" >&2; exit 1; }
  mkdir -p "$ZIEL/$(dirname "$pfad")"
  cp -R "$pfad" "$ZIEL/$(dirname "$pfad")/"
}

# Betrieb
kopieren docker-compose.yml
kopieren docker/mariadb/my.cnf
kopieren .env.example
kopieren package.json
kopieren package-lock.json
kopieren server
kopieren dist

# Betriebsanleitung: nur die Dokumente, die am Server-PC gebraucht werden.
kopieren docs/backup.md
kopieren docs/mariadb-setup.md
kopieren SECURITY.md

# Backup-Werkzeuge — ohne die ist docs/backup.md nur eine Absichtserklaerung.
kopieren scripts/backup.sh
kopieren scripts/restore.sh
kopieren scripts/lib/db.sh

# Tests gehoeren nicht ins Kundenpaket.
rm -rf "$ZIEL/server/tests"

cat > "$ZIEL/VERSION" <<ENDE
version=$VERSION
gebaut=$(date -u +%Y-%m-%dT%H:%M:%SZ)
commit=$(git rev-parse --short HEAD 2> /dev/null || echo "unbekannt")
node=$(node -v)
ENDE

cat > "$ZIEL/INSTALLATION.md" <<'ENDE'
# TÜV Prüfstelle Pro — Installation am Server-PC

## Voraussetzungen

- Docker Desktop (Windows/macOS) oder Docker Engine (Linux)
- Ein PC im Netzwerk der Prüfstelle, der durchlaufen kann

## Schritte

1. Dieses Paket auf dem Server-PC auspacken.

2. `.env` aus der Vorlage anlegen:

   ```
   cp .env.example .env
   ```

3. In der `.env` mindestens setzen:

   - `ADMIN_TOKEN` — ohne diesen Wert startet die Anwendung absichtlich
     nicht. Erzeugen mit `openssl rand -hex 32`.
   - `MARIADB_ROOT_PASSWORD` — wird für Backup und Restore gebraucht.
   - `MARIADB_PASSWORD` — Passwort des Anwendungsbenutzers.
   - `DEFAULT_USER_PASSWORT` — Startpasswort der drei Konten.

4. Starten:

   ```
   docker compose up -d
   ```

5. Im Browser `http://<server-ip>:8787` öffnen und mit `chef` und dem
   Startpasswort anmelden.

6. **Passwörter der drei Konten ändern.** Das Startpasswort greift nur beim
   Anlegen; es ist kein Betriebspasswort.

7. Backup einrichten: `docs/backup.md` Abschnitt 5. Der Verschlüsselungs-
   schlüssel gehört ausgedruckt in den Tresor — ohne ihn ist jedes Backup
   wertlos.

8. Ersten Restore gemeinsam proben:

   ```
   ./scripts/restore.sh --ziel-db tuv_probe backups/taeglich/<datei>
   ```

   Ein Backup, das nie zurückgespielt wurde, ist eine Vermutung.

## Aktualisieren

1. `docker compose down`
2. Backup ziehen: `./scripts/backup.sh`
3. Neues Paket auspacken, `.env` übernehmen
4. `docker compose up -d` — Schema-Migrationen laufen beim Start selbst

## Was in diesem Paket NICHT enthalten ist

Frontend-Quellcode, Tests und Projektdokumentation. Die liegen im
Repository; für den Betrieb werden sie nicht gebraucht.
ENDE

# Prüfsummen ueber jede Datei: der Kunde kann feststellen, ob das Paket
# unterwegs veraendert wurde, und wir koennen bei einem Supportfall die
# ausgelieferte Fassung eindeutig bestimmen.
(
  cd "$ZIEL"
  if command -v sha256sum > /dev/null 2>&1; then
    find . -type f ! -name PRUEFSUMMEN.txt -exec sha256sum {} \; | sort -k2 > PRUEFSUMMEN.txt
  else
    find . -type f ! -name PRUEFSUMMEN.txt -exec shasum -a 256 {} \; | sort -k2 > PRUEFSUMMEN.txt
  fi
)

mkdir -p "$AUSGABE"
ARCHIV="$AUSGABE/$NAME.tar.gz"
tar -czf "$ARCHIV" -C "$BAU" "$NAME"

if command -v sha256sum > /dev/null 2>&1; then
  (cd "$AUSGABE" && sha256sum "$NAME.tar.gz" > "$NAME.tar.gz.sha256")
else
  (cd "$AUSGABE" && shasum -a 256 "$NAME.tar.gz" > "$NAME.tar.gz.sha256")
fi

# Selbstkontrolle: ein Paket ohne dist/index.html oder ohne server/index.js
# startet beim Kunden nicht. Lieber hier scheitern als dort.
for pflicht in "$NAME/server/index.js" "$NAME/dist/index.html" \
  "$NAME/docker-compose.yml" "$NAME/scripts/restore.sh" "$NAME/INSTALLATION.md"; do
  tar -tzf "$ARCHIV" | grep -qx "$pflicht" || {
    echo "FEHLER: $pflicht fehlt im Archiv." >&2
    exit 1
  }
done
# Und nichts, was dort nicht hingehoert.
if tar -tzf "$ARCHIV" | grep -qE "/(node_modules|src|\.env)$|/\.env/"; then
  echo "FEHLER: Archiv enthaelt Dateien, die nicht ausgeliefert werden duerfen." >&2
  exit 1
fi

echo "  Paket    : $ARCHIV"
echo "  Groesse  : $(wc -c < "$ARCHIV" | tr -d ' ') Bytes"
echo "  Prüfsumme: $(cat "$AUSGABE/$NAME.tar.gz.sha256")"
echo "  Dateien  : $(tar -tzf "$ARCHIV" | wc -l | tr -d ' ')"
