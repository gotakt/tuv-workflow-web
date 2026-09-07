#!/usr/bin/env bash
#
# Restore aus einem Backup von scripts/backup.sh (siehe docs/backup.md §6).
#
#   ./scripts/restore.sh                              # neuestes Backup
#   ./scripts/restore.sh backups/taeglich/xy.sql.enc  # bestimmtes Backup
#   ./scripts/restore.sh --ziel-db tuv_probe          # in eine Test-DB
#
# Der Restore ist der Ernstfall: er ueberschreibt eine Datenbank. Deshalb
#   - fragt er nach, wenn das Ziel die Produktions-DB ist (--ja ueberspringt),
#   - prueft er den Klartext-Hash aus der .meta-Datei VOR dem Einspielen,
#   - prueft er nach dem Einspielen, ob der WF-01-Trigger wieder da ist.
#
# Der letzte Punkt ist kein Detail: ein Dump ohne --triggers spielt sich
# fehlerfrei ein und laesst die Datenbank ohne ihre Schutzschicht zurueck.

set -euo pipefail

SKRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/db.sh
. "$SKRIPT_DIR/lib/db.sh"
trap 'db_cleanup' EXIT

QUELLE="${BACKUP_ZIEL:-$SKRIPT_DIR/../backups}"
ARTEFAKT=""
ZIEL_DB="$MARIADB_DATABASE"
OHNE_RUECKFRAGE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --ziel-db) ZIEL_DB="$2"; shift 2 ;;
    --quelle) QUELLE="$2"; shift 2 ;;
    --ja) OHNE_RUECKFRAGE=1; shift ;;
    -h|--help) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "Unbekannte Option: $1" >&2; exit 2 ;;
    *) ARTEFAKT="$1"; shift ;;
  esac
done

if [ -z "$ARTEFAKT" ]; then
  [ -f "$QUELLE/latest" ] || {
    echo "FEHLER: Kein Backup angegeben und $QUELLE/latest existiert nicht." >&2
    exit 1
  }
  ARTEFAKT="$QUELLE/taeglich/$(cat "$QUELLE/latest")"
fi

[ -f "$ARTEFAKT" ] || { echo "FEHLER: Backup nicht gefunden: $ARTEFAKT" >&2; exit 1; }

echo "TÜV Prüfstelle Pro — Restore"
echo "  Backup   : $ARTEFAKT"
echo "  Ziel-DB  : $ZIEL_DB"
echo "  Zugriff  : $(db_modus)"

if [ "$ZIEL_DB" = "$MARIADB_DATABASE" ] && [ "$OHNE_RUECKFRAGE" -eq 0 ]; then
  echo
  echo "  ACHTUNG: '$ZIEL_DB' wird vollstaendig ueberschrieben."
  printf "  Zum Fortfahren 'restore' eingeben: "
  read -r antwort
  [ "$antwort" = "restore" ] || { echo "  Abgebrochen."; exit 1; }
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"; db_cleanup' EXIT

case "$ARTEFAKT" in
  *.enc)
    if [ -n "${BACKUP_PASSPHRASE_FILE:-}" ]; then
      cp "$BACKUP_PASSPHRASE_FILE" "$TMP_DIR/pass.key"
    elif [ -n "${BACKUP_PASSPHRASE:-}" ]; then
      printf '%s' "$BACKUP_PASSPHRASE" > "$TMP_DIR/pass.key"
    else
      echo "FEHLER: Backup ist verschluesselt, aber kein Schluessel gesetzt." >&2
      echo "  BACKUP_PASSPHRASE_FILE oder BACKUP_PASSPHRASE setzen." >&2
      exit 1
    fi
    chmod 600 "$TMP_DIR/pass.key"
    echo "  -> entschluesseln ..."
    if ! openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
      -in "$ARTEFAKT" -out "$TMP_DIR/dump.sql" \
      -pass "file:$TMP_DIR/pass.key" 2> "$TMP_DIR/openssl.err"; then
      echo "FEHLER: Entschluesseln fehlgeschlagen — falscher Schluessel?" >&2
      sed 's/^/  /' "$TMP_DIR/openssl.err" >&2
      exit 1
    fi
    ;;
  *)
    cp "$ARTEFAKT" "$TMP_DIR/dump.sql"
    ;;
esac

# Integritaet gegen die .meta-Datei pruefen, BEVOR etwas ueberschrieben wird.
if [ -f "$ARTEFAKT.meta" ]; then
  ERWARTET="$(grep '^klartext_sha256=' "$ARTEFAKT.meta" | cut -d= -f2)"
  TATSAECHLICH="$(sha256 "$TMP_DIR/dump.sql")"
  if [ -n "$ERWARTET" ] && [ "$ERWARTET" != "$TATSAECHLICH" ]; then
    echo "FEHLER: Pruefsumme stimmt nicht — Backup ist beschaedigt." >&2
    echo "  erwartet    : $ERWARTET" >&2
    echo "  tatsaechlich: $TATSAECHLICH" >&2
    exit 1
  fi
  echo "  -> Pruefsumme ok ($TATSAECHLICH)"
else
  echo "  -> WARNUNG: keine .meta-Datei, Pruefsumme nicht verifizierbar."
fi

echo "  -> Ziel-Datenbank neu anlegen ..."
db_sql_server "DROP DATABASE IF EXISTS \`$ZIEL_DB\`;
               CREATE DATABASE \`$ZIEL_DB\`
                 CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"

echo "  -> einspielen ..."
db_import "$ZIEL_DB" < "$TMP_DIR/dump.sql"

# Nachkontrolle. Ein Restore gilt erst als erfolgreich, wenn Tabellen UND
# Trigger wieder da sind.
TABELLEN="$(db_sql "SELECT COUNT(*) FROM information_schema.tables
                    WHERE table_schema='$ZIEL_DB';" "$ZIEL_DB")"
TRIGGER="$(db_sql "SELECT COUNT(*) FROM information_schema.triggers
                   WHERE trigger_schema='$ZIEL_DB'
                     AND trigger_name='trg_termin_wf01_update';" "$ZIEL_DB")"

echo "  Tabellen : $TABELLEN"
echo "  WF-01-Trigger: $TRIGGER"

if [ "$TABELLEN" -lt 1 ]; then
  echo "FEHLER: Restore hat keine Tabellen erzeugt." >&2
  exit 1
fi
if [ "$TRIGGER" != "1" ]; then
  echo "FEHLER: WF-01-Trigger fehlt nach dem Restore." >&2
  echo "  Die Datenbank waere ohne ihre Schutzschicht weitergelaufen." >&2
  exit 1
fi

echo "  Restore abgeschlossen."
