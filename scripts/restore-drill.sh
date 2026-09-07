#!/usr/bin/env bash
#
# Restore-Drill: beweist, dass aus einem Backup wieder eine vollstaendige,
# funktionsfaehige Datenbank wird — nicht, dass eine Backup-Datei existiert.
#
#   ./scripts/restore-drill.sh
#
# Ablauf:
#   1. Fingerabdruck der Quell-DB nehmen (normalisierter Dump, sha256)
#   2. Backup schreiben (scripts/backup.sh)
#   3. Datenbank ZERSTOEREN — nicht simulieren, wirklich DROP DATABASE
#   4. Restore (scripts/restore.sh)
#   5. Fingerabdruck erneut nehmen und vergleichen
#   6. Zeilenzahlen der Geschaeftstabellen und den WF-01-Trigger pruefen
#   7. Gegenprobe: ein absichtlich beschaedigtes Backup MUSS abgelehnt werden
#
# Schritt 7 ist der Grund, warum dieser Drill etwas wert ist. Ein Drill, der
# nur den guten Fall durchlaeuft, wuerde auch dann gruen bleiben, wenn die
# Pruefsummen-Kontrolle in restore.sh gar nichts prueft.
#
# Sicherung gegen Unfaelle: der Drill laeuft NUR gegen eine Datenbank, deren
# Name mit "tuv_drill" beginnt oder wenn TUV_DRILL_ERLAUBE_ZIEL_DB gesetzt
# ist. Sonst koennte ein Tippfehler die Produktions-DB der Prüfstelle loeschen.

set -euo pipefail

SKRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/db.sh
. "$SKRIPT_DIR/lib/db.sh"
trap 'db_cleanup' EXIT

QUELL_DB="$MARIADB_DATABASE"
ARBEITS_DIR="${TUV_DRILL_DIR:-$(mktemp -d)}"
BACKUP_DIR="$ARBEITS_DIR/backups"

case "$QUELL_DB" in
  tuv_drill*) ;;
  *)
    if [ -z "${TUV_DRILL_ERLAUBE_ZIEL_DB:-}" ]; then
      cat >&2 <<ENDE
FEHLER: Der Drill zerstoert die Datenbank '$QUELL_DB' und stellt sie wieder her.

Gegen eine Wegwerf-Datenbank laufen lassen:
  MARIADB_DATABASE=tuv_drill ./scripts/restore-drill.sh

Wenn '$QUELL_DB' wirklich eine Wegwerf-Datenbank ist:
  TUV_DRILL_ERLAUBE_ZIEL_DB=1 ./scripts/restore-drill.sh
ENDE
      exit 1
    fi
    ;;
esac

fehler() { echo; echo "DRILL FEHLGESCHLAGEN: $*" >&2; exit 1; }
schritt() { echo; echo "── $* ─────────────────────────────────────"; }

echo "TÜV Prüfstelle Pro — Restore-Drill"
echo "  Datenbank : $QUELL_DB"
echo "  Zugriff   : $(db_modus)"
echo "  Arbeitsdir: $ARBEITS_DIR"

# In der CI und lokal ohne Schluessel: Klartext ist hier vertretbar, der Drill
# laeuft ausschliesslich gegen synthetische Daten. Ist ein Schluessel gesetzt,
# wird der verschluesselte Pfad geprueft — der ist der Ernstfall.
if [ -n "${BACKUP_PASSPHRASE:-}${BACKUP_PASSPHRASE_FILE:-}" ]; then
  BACKUP_ARGS=""
  echo "  Modus     : verschluesselt"
else
  BACKUP_ARGS="--klartext"
  echo "  Modus     : Klartext (kein BACKUP_PASSPHRASE gesetzt)"
fi

# --- 1. Fingerabdruck vorher ---------------------------------------------
schritt "1/7  Fingerabdruck der Quell-Datenbank"
db_fingerprint "$QUELL_DB" > "$ARBEITS_DIR/vorher.sql"
FP_VORHER="$(sha256 "$ARBEITS_DIR/vorher.sql")"
echo "  sha256: $FP_VORHER"

zeilen() { db_sql "SELECT COUNT(*) FROM \`$1\`;" "$QUELL_DB"; }
TABELLEN_LISTE="halter fahrzeug termin mangel benutzer status pruefart pruefer mangel_kategorie schema_migration"
ZEILEN_VORHER=""
for t in $TABELLEN_LISTE; do
  n="$(zeilen "$t")"
  ZEILEN_VORHER="$ZEILEN_VORHER$t=$n "
  echo "  $t: $n"
done

# Ein Drill gegen eine leere Datenbank beweist nichts.
GESAMT="$(db_sql "SELECT COUNT(*) FROM termin;" "$QUELL_DB")"
[ "$GESAMT" -gt 0 ] || fehler "Quell-Datenbank enthaelt keine Termine — nichts zu beweisen."

# --- 2. Backup ------------------------------------------------------------
schritt "2/7  Backup schreiben"
# shellcheck disable=SC2086
BACKUP_ZIEL="$BACKUP_DIR" "$SKRIPT_DIR/backup.sh" --ziel "$BACKUP_DIR" $BACKUP_ARGS

ARTEFAKT="$BACKUP_DIR/taeglich/$(cat "$BACKUP_DIR/latest")"
[ -f "$ARTEFAKT" ] || fehler "Backup-Artefakt nicht gefunden: $ARTEFAKT"
echo "  Artefakt: $ARTEFAKT"

# --- 3. Datenbank zerstoeren ---------------------------------------------
schritt "3/7  Datenbank zerstoeren (DROP DATABASE)"
db_sql_server "DROP DATABASE \`$QUELL_DB\`;"
UEBRIG="$(db_sql_server "SELECT COUNT(*) FROM information_schema.schemata
                         WHERE schema_name='$QUELL_DB';")"
[ "$UEBRIG" = "0" ] || fehler "Datenbank existiert noch — Drill haette nichts geprueft."
echo "  Datenbank '$QUELL_DB' ist weg."

# --- 4. Restore -----------------------------------------------------------
schritt "4/7  Restore aus dem Backup"
BACKUP_ZIEL="$BACKUP_DIR" "$SKRIPT_DIR/restore.sh" --ja --ziel-db "$QUELL_DB" "$ARTEFAKT"

# --- 5. Fingerabdruck vergleichen ----------------------------------------
schritt "5/7  Fingerabdruck vergleichen"
db_fingerprint "$QUELL_DB" > "$ARBEITS_DIR/nachher.sql"
FP_NACHHER="$(sha256 "$ARBEITS_DIR/nachher.sql")"
echo "  vorher : $FP_VORHER"
echo "  nachher: $FP_NACHHER"
if [ "$FP_VORHER" != "$FP_NACHHER" ]; then
  echo "  Unterschiede:" >&2
  diff "$ARBEITS_DIR/vorher.sql" "$ARBEITS_DIR/nachher.sql" | head -40 >&2 || true
  fehler "Wiederhergestellte Datenbank weicht vom Original ab."
fi
echo "  Identisch."

# --- 6. Zeilenzahlen und Trigger -----------------------------------------
schritt "6/7  Geschaeftstabellen und WF-01-Trigger"
for t in $TABELLEN_LISTE; do
  vorher="$(echo "$ZEILEN_VORHER" | tr ' ' '\n' | grep "^$t=" | cut -d= -f2)"
  nachher="$(zeilen "$t")"
  if [ "$vorher" != "$nachher" ]; then
    fehler "Tabelle $t: $vorher Zeilen vorher, $nachher nachher."
  fi
  echo "  $t: $nachher ✓"
done

TRIGGER="$(db_sql "SELECT COUNT(*) FROM information_schema.triggers
                   WHERE trigger_schema='$QUELL_DB'
                     AND trigger_name='trg_termin_wf01_update';" "$QUELL_DB")"
[ "$TRIGGER" = "1" ] || fehler "WF-01-Trigger nach dem Restore nicht vorhanden."
echo "  trg_termin_wf01_update ✓"

# Der Trigger ist nicht nur vorhanden, er greift auch: ein blockierter
# UPDATE muss weiterhin scheitern. "Trigger existiert" und "Trigger wirkt"
# sind zwei verschiedene Aussagen.
BLOCKIERT_ID="$(db_sql "SELECT t.termin_id FROM termin t
                        JOIN mangel m ON m.termin_id = t.termin_id
                        WHERE m.behoben = 0 AND m.kategorie_code IN ('EM','GfM')
                        LIMIT 1;" "$QUELL_DB")"
if [ -n "$BLOCKIERT_ID" ]; then
  if db_sql "UPDATE termin SET status_code='Bestanden'
             WHERE termin_id='$BLOCKIERT_ID';" "$QUELL_DB" > /dev/null 2>&1; then
    fehler "Trigger existiert, greift aber nicht — UPDATE ging durch."
  fi
  echo "  Trigger greift nach dem Restore (UPDATE abgelehnt) ✓"
else
  echo "  Hinweis: kein blockierter Termin in den Daten, Wirkungstest uebersprungen."
fi

# --- 7. Gegenprobe: beschaedigtes Backup muss abgelehnt werden -----------
schritt "7/7  Gegenprobe mit beschaedigtem Backup"
KAPUTT="$ARBEITS_DIR/kaputt$(basename "$ARTEFAKT" | sed 's/^[^.]*//')"
cp "$ARTEFAKT" "$KAPUTT"
cp "$ARTEFAKT.meta" "$KAPUTT.meta"
# Ein Byte kippen — genau das, was ein schleichender Speicherfehler oder ein
# abgebrochener Upload hinterlaesst.
printf 'x' | dd of="$KAPUTT" bs=1 seek=64 conv=notrunc status=none

if BACKUP_ZIEL="$BACKUP_DIR" "$SKRIPT_DIR/restore.sh" --ja \
  --ziel-db "${QUELL_DB}_gegenprobe" "$KAPUTT" > "$ARBEITS_DIR/gegenprobe.log" 2>&1; then
  cat "$ARBEITS_DIR/gegenprobe.log" >&2
  fehler "Beschaedigtes Backup wurde eingespielt — die Pruefung greift nicht."
fi
echo "  Beschaedigtes Backup korrekt abgelehnt ✓"
db_sql_server "DROP DATABASE IF EXISTS \`${QUELL_DB}_gegenprobe\`;" > /dev/null 2>&1 || true

echo
echo "════════════════════════════════════════════════"
echo " RESTORE-DRILL BESTANDEN"
echo "   Backup -> DROP DATABASE -> Restore -> identisch"
echo "   Fingerabdruck: $FP_NACHHER"
echo "════════════════════════════════════════════════"
