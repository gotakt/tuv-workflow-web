#!/usr/bin/env bash
# Gemeinsame DB-Zugriffsschicht fuer die Backup-/Restore-Skripte.
#
# Die Skripte muessen an drei Orten laufen:
#   - Server-PC der Prüfstelle  -> MariaDB im Docker-Container
#   - GitHub-Actions-CI         -> MariaDB als Service, Client per apt
#   - Entwickler-Maschine       -> lokal installierter MariaDB-Server
#
# Statt drei Varianten der Skripte zu pflegen, entscheidet diese Datei einmal,
# WIE geredet wird (db_sql / db_dump / db_import), und alles darueber bleibt
# gleich. Gleiche Idee wie server/tests/dbCli.js auf der Test-Seite.

MARIADB_HOST="${MARIADB_HOST:-127.0.0.1}"
MARIADB_PORT="${MARIADB_PORT:-3306}"
MARIADB_USER="${MARIADB_USER:-tuv_app}"
MARIADB_PASSWORD="${MARIADB_PASSWORD:-tuv_app_pw}"
MARIADB_DATABASE="${MARIADB_DATABASE:-tuv_workflow}"
TUV_DB_CONTAINER="${TUV_DB_CONTAINER:-tuv-mariadb}"

# Backup und vor allem Restore brauchen mehr Rechte als die Anwendung: der
# App-Benutzer aus docker-compose.yml hat nur Rechte auf tuv_workflow.* und
# darf kein DROP/CREATE DATABASE. Ist ein Root-Passwort gesetzt (so steht es
# in der .env beim Kunden), benutzen die Skripte es. Sonst laufen sie mit dem
# App-Benutzer weiter — das reicht ueberall dort, wo er ohnehin alle Rechte
# hat (CI, lokale Entwicklung).
if [ -n "${MARIADB_ROOT_PASSWORD:-}" ]; then
  MARIADB_USER="${MARIADB_ADMIN_USER:-root}"
  MARIADB_PASSWORD="$MARIADB_ROOT_PASSWORD"
fi

# Das Passwort darf nicht als -p<pw> auf die Kommandozeile: dort liest es
# jeder Benutzer des Server-PCs per `ps aux` mit. Stattdessen eine temporaere
# Option-Datei mit 0600. MYSQL_PWD waere die Alternative, aber der Client ab
# MariaDB 12 haelt eine MYSQL_PWD-Anmeldung faelschlich fuer passwortlos und
# schreibt bei jedem Aufruf eine SSL-Warnung nach stderr — genau dorthin, wo
# die Skripte auf echte Fehler achten.
DB_OPT_DATEI="$(mktemp "${TMPDIR:-/tmp}/tuv-db-XXXXXX")"
chmod 600 "$DB_OPT_DATEI"
printf '[client]\npassword=%s\n' "$MARIADB_PASSWORD" > "$DB_OPT_DATEI"

# Muss vom aufrufenden Skript im EXIT-Trap aufgerufen werden.
db_cleanup() { rm -f "$DB_OPT_DATEI"; }

DB_MODE=""
DB_CLIENT=""
DB_DUMPER=""

db_erkennen() {
  [ -n "$DB_MODE" ] && return 0

  # 1. Direkter Client (CI, lokales Setup)
  local client dumper
  for client in mariadb mysql; do
    if command -v "$client" > /dev/null 2>&1 &&
      "$client" --defaults-extra-file="$DB_OPT_DATEI" \
        -h "$MARIADB_HOST" -P "$MARIADB_PORT" -u "$MARIADB_USER" \
        -e "SELECT 1;" > /dev/null 2>&1; then
      for dumper in mariadb-dump mysqldump; do
        if command -v "$dumper" > /dev/null 2>&1; then
          DB_MODE="client"
          DB_CLIENT="$client"
          DB_DUMPER="$dumper"
          return 0
        fi
      done
    fi
  done

  # 2. Docker-Container (Compose-Stack beim Kunden)
  if command -v docker > /dev/null 2>&1 &&
    docker exec "$TUV_DB_CONTAINER" mariadb -u "$MARIADB_USER" \
      -e "SELECT 1;" > /dev/null 2>&1; then
    DB_MODE="docker"
    return 0
  fi

  echo "FEHLER: Keine Verbindung zur Datenbank." >&2
  echo "  Weder ein Client auf ${MARIADB_HOST}:${MARIADB_PORT} noch der" >&2
  echo "  Container '${TUV_DB_CONTAINER}' war erreichbar." >&2
  return 1
}

db_modus() {
  db_erkennen || return 1
  if [ "$DB_MODE" = "docker" ]; then
    echo "docker exec ${TUV_DB_CONTAINER}"
  else
    echo "${DB_CLIENT} @ ${MARIADB_HOST}:${MARIADB_PORT}"
  fi
}

# db_sql <sql> [datenbank] — SQL ausfuehren, Ergebnis ohne Spaltenkopf auf stdout
db_sql() {
  local sql="$1"
  local datenbank="${2:-$MARIADB_DATABASE}"
  db_erkennen || return 1
  if [ "$DB_MODE" = "docker" ]; then
    docker exec -e MYSQL_PWD="$MARIADB_PASSWORD" "$TUV_DB_CONTAINER" \
      mariadb -u "$MARIADB_USER" -N -B "$datenbank" -e "$sql"
  else
    "$DB_CLIENT" --defaults-extra-file="$DB_OPT_DATEI" \
      -h "$MARIADB_HOST" -P "$MARIADB_PORT" -u "$MARIADB_USER" \
      -N -B "$datenbank" -e "$sql"
  fi
}

# db_sql_server <sql> — SQL ohne feste Datenbank (CREATE/DROP DATABASE)
db_sql_server() {
  local sql="$1"
  db_erkennen || return 1
  if [ "$DB_MODE" = "docker" ]; then
    docker exec -e MYSQL_PWD="$MARIADB_PASSWORD" "$TUV_DB_CONTAINER" \
      mariadb -u "$MARIADB_USER" -N -B -e "$sql"
  else
    "$DB_CLIENT" --defaults-extra-file="$DB_OPT_DATEI" \
      -h "$MARIADB_HOST" -P "$MARIADB_PORT" -u "$MARIADB_USER" \
      -N -B -e "$sql"
  fi
}

# db_dump [datenbank] — vollstaendiger Dump auf stdout.
#
# --routines/--events sind bei mariadb-dump NICHT default und muessen mit;
# --triggers ist default, steht hier aber trotzdem explizit: ein
# skip-triggers in einer my.cnf auf dem Server-PC wuerde sonst unbemerkt den
# WF-01-Trigger aus jedem Backup entfernen. Der Restore liefe fehlerfrei und
# die Datenbank haette ihre Schutzschicht verloren. backup.sh prueft das
# Ergebnis zusaetzlich, statt sich auf die Flags zu verlassen.
# --single-transaction: konsistenter Snapshot ohne die laufende Prüfstelle
# zu sperren (InnoDB).
db_dump() {
  local datenbank="${1:-$MARIADB_DATABASE}"
  db_erkennen || return 1
  local flags=(
    --single-transaction
    --routines
    --triggers
    --events
    --default-character-set=utf8mb4
  )
  if [ "$DB_MODE" = "docker" ]; then
    docker exec -e MYSQL_PWD="$MARIADB_PASSWORD" "$TUV_DB_CONTAINER" \
      mariadb-dump -u "$MARIADB_USER" "${flags[@]}" "$datenbank"
  else
    "$DB_DUMPER" --defaults-extra-file="$DB_OPT_DATEI" \
      -h "$MARIADB_HOST" -P "$MARIADB_PORT" -u "$MARIADB_USER" \
      "${flags[@]}" "$datenbank"
  fi
}

# db_fingerprint [datenbank] — normalisierter Dump auf stdout.
#
# Zweck: zwei Datenbanken vergleichbar machen. Deshalb ohne Zeitstempel und
# Kommentare (die sich bei jedem Dump aendern) und mit --order-by-primary
# (sonst kann die Zeilenreihenfolge nach einem Restore abweichen, obwohl die
# Daten identisch sind). Der sha256 darueber ist der eigentliche Beweis, dass
# ein Restore inhaltlich nichts verloren hat.
db_fingerprint() {
  local datenbank="${1:-$MARIADB_DATABASE}"
  db_erkennen || return 1
  local flags=(
    --single-transaction
    --routines
    --triggers
    --events
    --default-character-set=utf8mb4
    --skip-dump-date
    --skip-comments
    --order-by-primary
  )
  if [ "$DB_MODE" = "docker" ]; then
    docker exec -e MYSQL_PWD="$MARIADB_PASSWORD" "$TUV_DB_CONTAINER" \
      mariadb-dump -u "$MARIADB_USER" "${flags[@]}" "$datenbank"
  else
    "$DB_DUMPER" --defaults-extra-file="$DB_OPT_DATEI" \
      -h "$MARIADB_HOST" -P "$MARIADB_PORT" -u "$MARIADB_USER" \
      "${flags[@]}" "$datenbank"
  fi
}

# db_import <datenbank> — SQL von stdin einspielen
db_import() {
  local datenbank="$1"
  db_erkennen || return 1
  if [ "$DB_MODE" = "docker" ]; then
    docker exec -i -e MYSQL_PWD="$MARIADB_PASSWORD" "$TUV_DB_CONTAINER" \
      mariadb -u "$MARIADB_USER" --default-character-set=utf8mb4 "$datenbank"
  else
    "$DB_CLIENT" --defaults-extra-file="$DB_OPT_DATEI" \
      -h "$MARIADB_HOST" -P "$MARIADB_PORT" -u "$MARIADB_USER" \
      --default-character-set=utf8mb4 "$datenbank"
  fi
}

# sha256 <datei> — plattformneutral (macOS liefert shasum, Linux sha256sum)
sha256() {
  if command -v sha256sum > /dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}
