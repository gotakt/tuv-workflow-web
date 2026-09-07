# Backup- und Restore-Konzept

Stand: 2026-09-07
Architektur: On-Premise pro Prüfstelle, MariaDB lokal.

## 1. Bedrohungsmodell

Welche Vorfälle muss eine Backup-Strategie abfangen?

| Szenario | Häufigkeit | Schutz durch |
|---|---|---|
| Server-PC-Festplatte stirbt | alle 3–5 Jahre realistisch | Backup auf zweites Gerät |
| Mitarbeiter löscht Termin versehentlich | jederzeit möglich | Point-in-Time-Recovery (Stunden zurück) |
| Ransomware verschlüsselt den Server | selten, aber existenzbedrohend | Offsite-Backup auf getrenntem Konto |
| Werkstatt brennt ab, Server wird gestohlen | sehr selten | Offsite-Cloud-Backup ausserhalb des Gebäudes |

Ein einfaches `mysqldump`-Cronjob auf der gleichen Festplatte schützt nur vor
dem ersten Szenario. Eine vollständige Strategie deckt alle vier ab

## 2. 3-Tier-Strategie (3-2-1-Regel)

Die Industrie-Faustregel lautet: **3 Kopien, 2 verschiedene Medien, 1 ausser
Haus**.

```text
┌──────────────────────────────────────────────────────────────┐
│ TIER 1 — Hot: Binary Logs (kontinuierlich)                   │
│ MariaDB schreibt jede Schreiboperation in das Binary-Log.    │
│ Damit ist Point-in-Time-Recovery bis auf die Sekunde der     │
│ letzten 14 Tage möglich.                                    │
│ Speicherort: lokal, gleiche Festplatte (mysql-bin.*).        │
└──────────────────────────────────────────────────────────────┘
                          │
                          │ alle 6 Stunden
                          ▼
┌──────────────────────────────────────────────────────────────┐
│ TIER 2 — Warm: verschlüsselter mysqldump                    │
│ Voller Datenbank-Dump, AES-256-verschlüsselt, auf einer     │
│ zweiten Festplatte oder einem NAS in der Werkstatt.          │
│ Rotation: 7 tägliche + 4 wöchentliche + 12 monatliche.     │
└──────────────────────────────────────────────────────────────┘
                          │
                          │ täglich, nachts
                          ▼
┌──────────────────────────────────────────────────────────────┐
│ TIER 3 — Cold: Offsite (Cloud, verschlüsselt)               │
│ Verschlüsselter Dump auf einer Hetzner Storage Box (DE,     │
│ GDPR-konform). Konto gehört dem Werkstatt-Inhaber, nicht    │
│ dem Software-Anbieter.                                       │
│ Aufbewahrung: 90 Tage rollierend.                            │
└──────────────────────────────────────────────────────────────┘
```

## 3. Warum diese Strategie sinnvoll ist

1. **Point-in-Time-Recovery via Binary Logs** — wird ein Termin versehentlich
   gelöscht, kann auf den Stand 1 Minute vor dem Löschen zurückgerollt
   werden. Verlust: nur die seitdem geschriebenen Daten.
2. **Verschlüsselung BEVOR das Backup das Gerät verlässt** — der
   Verschlüsselungsschlüssel liegt nicht auf dem Server. Selbst eine
   Ransomware, die den Server vollständig kompromittiert, kann die
   verschlüsselten Backups nicht manipulieren.
3. **Kunden-eigene Cloud (Hetzner)** — der Werkstatt-Inhaber besitzt das
   Cloud-Konto. Rechtlich sauber (keine Auftragsverarbeitung beim Software-
   Anbieter), datenschutztechnisch stark.
4. **Automatischer Restore-Test** — ein Backup wird probeweise
   zurückgespielt und mit dem Original verglichen. So wird ein kaputtes
   Backup erkannt, bevor es im Ernstfall gebraucht wird. In der CI läuft das
   wöchentlich (Abschnitt 4a); am Kundenstandort fehlen dafür noch
   Zeitsteuerung und Alarmierung (Abschnitt 7).
5. **Versionierung mit Rotation** — ein Fehler fällt manchmal erst Wochen
   später auf. Mehrere Generationen sind nötig, nicht nur "Backup von
   gestern".

## 4. Was im Repository umgesetzt ist

- `docker-compose.yml` startet MariaDB mit aktiviertem Binary-Logging
  (`log_bin`, `binlog_format=ROW`, `expire_logs_days=14`).
- `docker/mariadb/my.cnf` enthält die Binlog-Konfiguration.
- `/backups` ist als Volume in den Container gemounted (siehe
  `docker-compose.yml`).
- `.gitignore` schließt `/backups` aus.
- **`scripts/backup.sh`** — Tier 2: verschlüsselter Dump (AES-256-CBC,
  PBKDF2 mit 200 000 Runden), Rotation 7 täglich / 4 wöchentlich /
  12 monatlich, Prüfsummen in einer `.meta`-Datei je Sicherung.
  Ohne gesetzten Schlüssel bricht das Skript ab, statt einen
  unverschlüsselten Dump mit Kundendaten zu schreiben.
- **`scripts/restore.sh`** — Ein-Befehl-Restore. Prüft die Prüfsumme
  **vor** dem Überschreiben und danach, ob der WF-01-Trigger wieder da
  ist. Rückfrage vor dem Überschreiben der Produktions-Datenbank.
- **`scripts/restore-drill.sh`** — die Probe aufs Exempel (§ 4a).
- **`scripts/lib/db.sh`** — gemeinsame Zugriffsschicht; dieselben Skripte
  laufen gegen den Docker-Stack, gegen die CI-Service-Datenbank und gegen
  eine lokal installierte MariaDB.

### 4a. Der Restore-Weg ist automatisiert geprüft

`.github/workflows/restore-drill.yml` läuft montags um 04:17 UTC und bei
jeder Änderung an den Skripten oder am Schema. Der Drill:

1. nimmt einen Fingerabdruck der Datenbank (normalisierter Dump, sha256),
2. schreibt ein **verschlüsseltes** Backup,
3. **löscht die Datenbank wirklich** (`DROP DATABASE`, nicht simuliert),
4. stellt sie aus dem Backup wieder her,
5. vergleicht den Fingerabdruck — er muss identisch sein,
6. prüft Zeilenzahlen aller Tabellen, die Existenz des WF-01-Triggers **und
   dass er greift** (ein gesperrter `UPDATE` muss weiterhin scheitern),
7. macht die Gegenprobe: ein absichtlich beschädigtes Backup **muss**
   abgelehnt werden.

Schritt 7 ist der Grund, warum der Drill etwas wert ist. Ein Drill, der nur
den guten Fall durchläuft, bliebe auch dann grün, wenn die Prüfsummen-
Kontrolle gar nichts prüft.

Lokal ausführen (gegen eine Wegwerf-Datenbank):

```bash
MARIADB_DATABASE=tuv_drill ./scripts/restore-drill.sh
```

Der Drill weigert sich, gegen eine Datenbank zu laufen, deren Name nicht mit
`tuv_drill` beginnt — er zerstört sie schließlich.

## 5. Was am Kunden-Standort einmal eingerichtet wird

1. **Hetzner Storage Box bestellen** (https://www.hetzner.com/storage/storage-box)
   - Kleinste Variante reicht: BX11 mit 1 TB für rund 4 EUR/Monat
   - Konto-Inhaber: der Werkstatt-Inhaber persönlich
2. **SFTP-Zugangsdaten** in `.env` auf dem Server-PC eintragen
3. **Verschlüsselungs-Schlüssel generieren** (256-Bit AES)
   - Schlüssel **ausgedruckt im Werkstatt-Tresor** aufbewahren
   - Schlüssel ist nicht wiederherstellbar — Verlust = Backup unbrauchbar
4. **Mitarbeiter-E-Mail** für Backup-Fehler-Alarmierung eintragen
5. **Erste Restore-Probe** gemeinsam durchführen

## 6. Notfall-Restore (Kurzfassung)

Bei Datenverlust:

```powershell
# 1. Container stoppen
docker compose down

# 2. Letztes Backup wiederherstellen
docker compose up -d db
docker exec -i tuv-mariadb mysql -u root -p"$MARIADB_ROOT_PASSWORD" `
  tuv_workflow < .\backups\latest\dump.sql

# 3. Point-in-Time bis zum Zeitpunkt X
docker exec -i tuv-mariadb mysqlbinlog `
  --stop-datetime="2026-05-17 14:31:00" `
  /var/lib/mysql/mysql-bin.000042 | docker exec -i tuv-mariadb mysql ...

# 4. API wieder starten
docker compose up -d
```

Bequemer und mit Prüfsummen-Kontrolle: `./scripts/restore.sh` (siehe Abschnitt 4).

## 7. Stand der Umsetzung

Erledigt:

- [x] `scripts/backup.sh` — verschlüsselter Dump mit Rotation (Tier 2)
- [x] `scripts/restore.sh` — Ein-Befehl-Restore mit Prüfsummen-Kontrolle
- [x] Wöchentlicher automatisierter Restore-Test
      (`.github/workflows/restore-drill.yml`)

Noch offen:

- [ ] **Zeitsteuerung am Server-PC.** `scripts/backup.sh` läuft heute auf
      Aufruf. Für den Betrieb muss es alle 6 Stunden gestartet werden —
      unter Windows per Aufgabenplanung, unter Linux per cron oder
      systemd-Timer. Das gehört ins Kunden-Setup, nicht ins Repository:
      Zeitpunkt und Zielpfad hängen vom Standort ab.
- [ ] `scripts/sync-offsite.sh` — Tier 3, SFTP-Sync zur Hetzner Storage Box
- [ ] Alarmierung per E-Mail, wenn ein Backup oder ein Restore-Test
      fehlschlägt. Der CI-Drill meldet sich über GitHub; am Kundenstandort
      gibt es diesen Kanal nicht.
- [ ] Point-in-Time-Recovery über die Binary Logs ist konfiguriert
      (Abschnitt 2, Tier 1), aber **nicht** durch ein Skript unterstützt und
      nicht automatisiert geprüft. Der Weg in Abschnitt 6 ist Handarbeit.

Bis diese Punkte erledigt sind, gilt: Tier 2 und der Restore-Weg sind
belegt, Tier 3 und die Alarmierung sind Konzept.
