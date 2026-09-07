#!/usr/bin/env bash
#
# Tier-2-Backup: verschluesselter Dump mit Rotation (siehe docs/backup.md).
#
#   ./scripts/backup.sh                      # verschluesselt nach ./backups
#   ./scripts/backup.sh --ziel /mnt/nas/tuv  # anderes Ziel (zweites Medium)
#   ./scripts/backup.sh --klartext           # NUR fuer Tests/CI
#
# Schluessel:
#   BACKUP_PASSPHRASE       Passphrase direkt (z. B. in CI-Secrets)
#   BACKUP_PASSPHRASE_FILE  Datei mit der Passphrase (bevorzugt am Server-PC)
#
# Ohne Schluessel bricht das Skript ab, statt einen unverschluesselten Dump
# mit Kundendaten zu schreiben. Ein Backup, das man versehentlich im Klartext
# auf ein NAS legt, ist ein Datenleck mit Aufbewahrungsfrist.

set -euo pipefail

SKRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/db.sh
. "$SKRIPT_DIR/lib/db.sh"
trap 'db_cleanup' EXIT

ZIEL="${BACKUP_ZIEL:-$SKRIPT_DIR/../backups}"
KLARTEXT=0

BEHALTE_TAEGLICH="${BACKUP_BEHALTE_TAEGLICH:-7}"
BEHALTE_WOECHENTLICH="${BACKUP_BEHALTE_WOECHENTLICH:-4}"
BEHALTE_MONATLICH="${BACKUP_BEHALTE_MONATLICH:-12}"

while [ $# -gt 0 ]; do
  case "$1" in
    --ziel) ZIEL="$2"; shift 2 ;;
    --klartext) KLARTEXT=1; shift ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unbekannte Option: $1" >&2; exit 2 ;;
  esac
done

passphrase_holen() {
  if [ -n "${BACKUP_PASSPHRASE_FILE:-}" ]; then
    [ -r "$BACKUP_PASSPHRASE_FILE" ] || {
      echo "FEHLER: BACKUP_PASSPHRASE_FILE nicht lesbar: $BACKUP_PASSPHRASE_FILE" >&2
      exit 1
    }
    cat "$BACKUP_PASSPHRASE_FILE"
  elif [ -n "${BACKUP_PASSPHRASE:-}" ]; then
    printf '%s' "$BACKUP_PASSPHRASE"
  else
    return 1
  fi
}

if [ "$KLARTEXT" -eq 0 ] && ! passphrase_holen > /dev/null 2>&1; then
  cat >&2 <<'ENDE'
FEHLER: Kein Verschluesselungs-Schluessel gesetzt.

  export BACKUP_PASSPHRASE_FILE=/etc/tuv/backup.key     (empfohlen)
  export BACKUP_PASSPHRASE='...'

Schluessel erzeugen und ausgedruckt im Tresor ablegen (docs/backup.md §5):
  openssl rand -base64 48 > /etc/tuv/backup.key && chmod 600 /etc/tuv/backup.key

Nur fuer Tests/CI ohne Kundendaten: --klartext
ENDE
  exit 1
fi

ZEITSTEMPEL="$(date +%Y%m%d-%H%M%S)"
BASIS="${MARIADB_DATABASE}-${ZEITSTEMPEL}"
TAG_DIR="$ZIEL/taeglich"
mkdir -p "$TAG_DIR" "$ZIEL/woechentlich" "$ZIEL/monatlich"

echo "TÜV Prüfstelle Pro — Backup"
echo "  Datenbank : $MARIADB_DATABASE"
echo "  Zugriff   : $(db_modus)"
echo "  Ziel      : $ZIEL"

# Erst in eine temporaere Datei dumpen, dann verschluesseln, dann an den
# endgueltigen Platz verschieben. So entsteht im Backup-Verzeichnis nie eine
# halbfertige Datei, die ein Restore fuer gueltig halten koennte.
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"; db_cleanup' EXIT

echo "  -> Dump laeuft ..."
db_dump > "$TMP_DIR/dump.sql"

KLARTEXT_SHA="$(sha256 "$TMP_DIR/dump.sql")"
ROHGROESSE="$(wc -c < "$TMP_DIR/dump.sql" | tr -d ' ')"

# Sanity-Check: ein Dump ohne CREATE TABLE ist kaputt (z. B. weil der Client
# still mit leerem Ergebnis zurueckkam). Lieber hier abbrechen als ein
# nutzloses Backup rotieren lassen und die gute Generation verdraengen.
if ! grep -q "CREATE TABLE" "$TMP_DIR/dump.sql"; then
  echo "FEHLER: Dump enthaelt keine CREATE TABLE — Backup verworfen." >&2
  exit 1
fi
if ! grep -q "trg_termin_wf01_update" "$TMP_DIR/dump.sql"; then
  echo "FEHLER: WF-01-Trigger fehlt im Dump — Backup verworfen." >&2
  echo "  Ein Restore daraus haette die DB-Verteidigungsschicht verloren." >&2
  exit 1
fi

if [ "$KLARTEXT" -eq 1 ]; then
  ARTEFAKT="$TAG_DIR/$BASIS.sql"
  mv "$TMP_DIR/dump.sql" "$ARTEFAKT"
  VERSCHLUESSELUNG="keine (--klartext)"
else
  passphrase_holen > "$TMP_DIR/pass.key"
  chmod 600 "$TMP_DIR/pass.key"
  openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
    -in "$TMP_DIR/dump.sql" -out "$TMP_DIR/dump.sql.enc" \
    -pass "file:$TMP_DIR/pass.key"
  ARTEFAKT="$TAG_DIR/$BASIS.sql.enc"
  mv "$TMP_DIR/dump.sql.enc" "$ARTEFAKT"
  VERSCHLUESSELUNG="AES-256-CBC (PBKDF2, 200000 Runden)"
fi

ARTEFAKT_SHA="$(sha256 "$ARTEFAKT")"

# Metadaten neben dem Artefakt: der Klartext-Hash ist das, woran restore.sh
# nach dem Entschluesseln erkennt, ob die Datei unterwegs beschaedigt wurde.
cat > "$ARTEFAKT.meta" <<ENDE
datenbank=$MARIADB_DATABASE
erstellt=$(date -u +%Y-%m-%dT%H:%M:%SZ)
verschluesselung=$VERSCHLUESSELUNG
klartext_bytes=$ROHGROESSE
klartext_sha256=$KLARTEXT_SHA
artefakt_sha256=$ARTEFAKT_SHA
ENDE

echo "$(basename "$ARTEFAKT")" > "$ZIEL/latest"

# --- Rotation -------------------------------------------------------------
# Montag zusaetzlich in die Wochen-, der Monatserste in die Monatsablage.
# Kopie statt Hardlink: die Generationen sollen auch dann noch existieren,
# wenn das Tagesbackup geloescht oder beschaedigt wird.
if [ "$(date +%u)" = "1" ]; then
  cp "$ARTEFAKT" "$ARTEFAKT.meta" "$ZIEL/woechentlich/"
fi
if [ "$(date +%d)" = "01" ]; then
  cp "$ARTEFAKT" "$ARTEFAKT.meta" "$ZIEL/monatlich/"
fi

aufraeumen() {
  local verzeichnis="$1" behalten="$2" datei anzahl=0
  [ -d "$verzeichnis" ] || return 0
  # Neueste zuerst; alles jenseits von $behalten faellt weg. .meta-Dateien
  # werden mit dem Artefakt zusammen entfernt. Kein `| while`: die Schleife
  # liefe in einer Subshell und ihr Rueckgabewert (1 am Ende der Eingabe)
  # wuerde unter `set -e` das ganze Backup als fehlgeschlagen melden.
  for datei in $(ls -1t "$verzeichnis" 2> /dev/null | grep -E '\.sql(\.enc)?$' || true); do
    anzahl=$((anzahl + 1))
    if [ "$anzahl" -gt "$behalten" ]; then
      rm -f "$verzeichnis/$datei" "$verzeichnis/$datei.meta"
      echo "  -> rotiert: $datei"
    fi
  done
  return 0
}

aufraeumen "$TAG_DIR" "$BEHALTE_TAEGLICH"
aufraeumen "$ZIEL/woechentlich" "$BEHALTE_WOECHENTLICH"
aufraeumen "$ZIEL/monatlich" "$BEHALTE_MONATLICH"

echo "  Fertig: $ARTEFAKT"
echo "  Groesse (Klartext): $ROHGROESSE Bytes"
echo "  Verschluesselung  : $VERSCHLUESSELUNG"
