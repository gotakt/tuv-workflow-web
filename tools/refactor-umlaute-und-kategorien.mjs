#!/usr/bin/env node
/**
 * Einmal-Refactor: ASCII-Umschreibungen (tuev, Pruefstelle, fuer, ...) auf
 * korrektes Deutsch mit Umlauten (TÜV, Prüfstelle, für, ...) sowie alte
 * Mangelkategorie-Listen (OM/LM/EM/HM/GM) auf HU-Richtlinie (OM/GM/EM/GfM).
 *
 * Sicherheits-Logik:
 *   - Technische Identifier (Docker-Container, DB-Name, URLs) bleiben ASCII.
 *   - Word-Boundary-Matching, wo sinnvoll.
 *   - Eine Deny-Liste von Dateien wird übersprungen.
 *
 * Aufruf:  node scripts/refactor-umlaute-und-kategorien.mjs [--dry]
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, extname, relative, sep } from "node:path";

const ROOT = process.cwd();
const DRY = process.argv.includes("--dry");

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "backups",
  "src-tauri", "public",
]);

const SKIP_FILES = new Set([
  "scripts/refactor-umlaute-und-kategorien.mjs", // dieses Script selbst
  "src/constants/kfzKreis.js",                  // Kreis-Codes HM/LM/GM = Stadtnamen
  "docs/architecture-map.html",                  // legacy SVG-Map
  "package-lock.json",
  "praesentation.pdf",
]);

// NUR Doku-Files refaktorieren. Source-Code (.ts/.tsx/.js/.jsx) NICHT
// anfassen, weil dort viele ASCII-Strings als Identifier/Property-Keys
// verwendet werden (z.B. `pruefer` als Object-Key in useStoreCompat.ts).
// UI-Strings in JSX bleiben damit unveraendert — die werden separat per
// Hand uebersetzt, wenn der Aufwand sich lohnt.
const FILE_EXTS = new Set([
  ".md", ".html",
]);

// === Umlaut-Ersetzungen (case-sensitive, in dieser Reihenfolge) ===
// Längere Patterns zuerst, damit z.B. "Pruefstelle" nicht durch "pruef"
// teilweise ersetzt wird.
const UMLAUT_RULES = [
  // tuev / TUEV / Tuev (vorsichtig: "tuv" ohne e bleibt — das sind Identifier)
  [/\bTUEV\b/g, "TÜV"],
  [/\bTuev\b/g, "Tüv"],
  [/\btuev\b/g, "tüv"],

  // Prüfstelle und Verwandte
  [/Pruefstellen/g, "Prüfstellen"],
  [/Pruefstelle/g, "Prüfstelle"],
  [/pruefstellen/g, "prüfstellen"],
  [/pruefstelle/g, "prüfstelle"],

  // Prüfung / Prüfberichte / Prüfer / Prüfart
  // (?!_) verhindert, dass DB-Spalten wie prueft_code, pruefer_kuerzel ersetzt werden.
  [/Pruefungen(?!_)/g, "Prüfungen"],
  [/Pruefung(?!_)/g, "Prüfung"],
  [/Pruefberichte(?!_)/g, "Prüfberichte"],
  [/Pruefbericht(?!_)/g, "Prüfbericht"],
  [/Pruefliste(?!_)/g, "Prüfliste"],
  [/Pruefarten(?!_)/g, "Prüfarten"],
  [/Pruefart(?!_)/g, "Prüfart"],
  [/Prueferin(?!_)/g, "Prüferin"],
  [/Pruefer(?!_)/g, "Prüfer"],
  [/Pruefen(?!_)/g, "Prüfen"],
  [/Prueft(?!_)/g, "Prüft"],
  [/pruefungen(?!_)/g, "prüfungen"],
  [/pruefung(?!_)/g, "prüfung"],
  [/pruefen(?!_)/g, "prüfen"],
  [/prueft(?!_)/g, "prüft"],
  // ACHTUNG: lowercase `pruefer` und `pruefart` sind die MariaDB-Table-Namen.
  // Sie als Wort umzuwandeln (`pruefer` -> `prüfer`) zerstört Code-Referenzen
  // in Docs (z.B. `pruefart` in Tabellen-Listen). Daher hier bewusst raus.
  // Capitalized `Pruefer`/`Pruefart` werden weiter oben behandelt (sind
  // unzweideutig deutsche Substantive im Satz-Anfang).

  // Mängel
  [/Maengelerfassung/g, "Mängelerfassung"],
  [/Maengel/g, "Mängel"],
  [/maengel/g, "mängel"],

  // für (nur als ganzes Wort, sonst trifft "Furor")
  [/\bfuer\b/g, "für"],
  [/\bFuer\b/g, "Für"],

  // möglich
  [/Moeglichkeit/g, "Möglichkeit"],
  [/moeglich/g, "möglich"],
  [/Moeglich/g, "Möglich"],

  // würde / würden
  [/wuerden/g, "würden"],
  [/wuerde/g, "würde"],
  [/Wuerden/g, "Würden"],
  [/Wuerde/g, "Würde"],

  // Änderung / ändern
  [/Aenderungen/g, "Änderungen"],
  [/Aenderung/g, "Änderung"],
  [/aenderungen/g, "änderungen"],
  [/aenderung/g, "änderung"],
  [/aendern/g, "ändern"],
  [/Aendern/g, "Ändern"],
  [/aendert/g, "ändert"],
  [/Aendert/g, "Ändert"],

  // Schlüssel
  [/Schluesselkandidaten/g, "Schlüsselkandidaten"],
  [/Schluesselkandidat/g, "Schlüsselkandidat"],
  [/Schluessel/g, "Schlüssel"],
  [/schluessel/g, "schlüssel"],

  // Integrität
  [/Integritaetsbedingung/g, "Integritätsbedingung"],
  [/Integritaetseinschraenkung/g, "Integritätseinschränkung"],
  [/Integritaet/g, "Integrität"],
  [/integritaet/g, "integrität"],

  // Abhängig / Abhängigkeit
  [/Abhaengigkeiten/g, "Abhängigkeiten"],
  [/Abhaengigkeit/g, "Abhängigkeit"],
  [/Abhaengig/g, "Abhängig"],
  [/abhaengigkeit/g, "abhängigkeit"],
  [/abhaengig/g, "abhängig"],

  // über- (Überprüfung, Überblick, übernehmen ...)
  [/Ueberblick/g, "Überblick"],
  [/Uebersicht/g, "Übersicht"],
  [/Ueberpruefung/g, "Überprüfung"],
  [/ueberpruefung/g, "überprüfung"],
  [/Ueberfuehren/g, "Überführen"],
  [/ueberfuehren/g, "überführen"],
  [/Ueberlegung/g, "Überlegung"],
  [/uebernehmen/g, "übernehmen"],
  [/Uebernehmen/g, "Übernehmen"],
  [/uebertragen/g, "übertragen"],
  [/Uebertragen/g, "Übertragen"],
  [/ueberein/g, "überein"],
  // Generisches "ueber" als Wort oder Präfix vor weiteren Buchstaben.
  // \b vorne, hinten frei — fängt "ueber den", "ueber HTTP" und Compounds.
  [/\bueber/g, "über"],
  [/\bUeber/g, "Über"],

  // Ergänzungen aus dem 2026-05-19 Cleanup (vorher uebersehen):
  [/ueblich/g, "üblich"],
  [/Ueblich/g, "Üblich"],
  [/waere/g, "wäre"],
  [/waeren/g, "wären"],
  [/Waere/g, "Wäre"],
  [/Waeren/g, "Wären"],
  [/eingefuehrt/g, "eingeführt"],
  [/einfuehren/g, "einführen"],
  [/Einfuehren/g, "Einführen"],
  [/eingefuehren/g, "eingeführen"],
  [/durchfuehren/g, "durchführen"],
  [/Durchfuehren/g, "Durchführen"],
  [/durchgefuehrt/g, "durchgeführt"],
  [/ausgefuehrt/g, "ausgeführt"],
  [/Ausfuehrung/g, "Ausführung"],
  [/Domaene/g, "Domäne"],
  [/domaene/g, "domäne"],
  [/fuehren/g, "führen"],
  [/Fuehren/g, "Führen"],
  [/gefuehrt/g, "geführt"],
  [/zwoelf/g, "zwölf"],
  [/Zwoelf/g, "Zwölf"],
  [/zukuenftige/g, "zukünftige"],
  [/zukuenftig/g, "zukünftig"],
  [/Zukuenftige/g, "Zukünftige"],
  [/spaeter/g, "später"],
  [/Spaeter/g, "Später"],
  [/haeufig/g, "häufig"],
  [/Haeufig/g, "Häufig"],
  [/duenn/g, "dünn"],
  [/Duenn/g, "Dünn"],
  [/Komplexitaet/g, "Komplexität"],
  [/komplexitaet/g, "komplexität"],
  [/uebersehen/g, "übersehen"],
  [/ueberschreitet/g, "überschreitet"],
  [/ueberpruefen/g, "überprüfen"],
  [/Ueberpruefen/g, "Überprüfen"],
  [/spezifisch/g, "spezifisch"], // no umlaut, filler
  [/textbuch/g, "textbuch"],
  [/maessig/g, "mäßig"],
  [/gemaess/g, "gemäß"],
  [/Gemaess/g, "Gemäß"],
  [/eindeutige/g, "eindeutige"], // no umlaut
  [/Verhaeltnis/g, "Verhältnis"],
  [/verhaeltnis/g, "verhältnis"],
  [/Anwendungs-Schicht/g, "Anwendungs-Schicht"], // no umlaut
  [/koennen/g, "können"],
  [/Koennen/g, "Können"],
  [/koennten/g, "könnten"],
  [/koennt/g, "könnt"],
  [/Loesung/g, "Lösung"],
  [/loesung/g, "lösung"],
  [/loescht/g, "löscht"],
  [/Loescht/g, "Löscht"],

  // ── Riesige Ergänzung Runde 3 (2026-05-20): Long-Tail-Wörter aus
  //    docs/backup.md, datenmodell.md, design.md, pflichtenheft.md,
  //    backlog.md, ki-nutzung.md, nacharbeit_fuchs.html.
  //    Pflicht: keine Identifier-Pattern (kein lowercase `pruefer`,
  //    kein `_faellig` etc — dafür haben wir bereits Lookahead-Sicherungen).

  // -ae- Wörter
  [/Vorfaelle/g, "Vorfälle"],
  [/Vorfaellen/g, "Vorfällen"],
  [/Vorfaell/g, "Vorfäll"],
  [/Geraete/g, "Geräte"],
  [/Geraeten/g, "Geräten"],
  [/Geraet\b/g, "Gerät"],
  [/geraet/g, "gerät"],
  [/Gebaeude/g, "Gebäude"],
  [/Gebaeudes/g, "Gebäudes"],
  [/gebaeude/g, "gebäude"],
  [/vollstaendige/g, "vollständige"],
  [/vollstaendig/g, "vollständig"],
  [/Vollstaendige/g, "Vollständige"],
  [/Vollstaendig/g, "Vollständig"],
  [/taegliche/g, "tägliche"],
  [/taeglich/g, "täglich"],
  [/Taegliche/g, "Tägliche"],
  [/Taeglich/g, "Täglich"],
  [/woechentliche/g, "wöchentliche"],
  [/woechentlich/g, "wöchentlich"],
  [/Woechentliche/g, "Wöchentliche"],
  [/monatliche/g, "monatliche"], // no umlaut
  [/jaehrliche/g, "jährliche"],
  [/jaehrlich/g, "jährlich"],
  [/Jaehrlich/g, "Jährlich"],
  [/gehoert/g, "gehört"],
  [/Gehoert/g, "Gehört"],
  [/gehoeren/g, "gehören"],
  [/verlaesst/g, "verlässt"],
  [/verlassen/g, "verlassen"], // no umlaut
  [/laesst/g, "lässt"],
  [/Laesst/g, "Lässt"],
  [/schlaegt/g, "schlägt"],
  [/Schlaegt/g, "Schlägt"],
  [/faellt/g, "fällt"],
  [/Faellt/g, "Fällt"],
  [/enthaelt/g, "enthält"],
  [/Enthaelt/g, "Enthält"],
  [/enthaelten/g, "enthalten"], // tricky — usually correct already
  [/persoenlich/g, "persönlich"],
  [/Persoenlich/g, "Persönlich"],
  [/naemlich/g, "nämlich"],
  [/Naemlich/g, "Nämlich"],
  [/aehnlich/g, "ähnlich"],
  [/Aehnlich/g, "Ähnlich"],
  [/aehnliche/g, "ähnliche"],
  [/Naehe/g, "Nähe"],
  [/naehe/g, "nähe"],
  [/gueltig/g, "gültig"],
  [/Gueltig/g, "Gültig"],
  [/tatsaechlich/g, "tatsächlich"],
  [/Tatsaechlich/g, "Tatsächlich"],
  [/saemtlich/g, "sämtlich"],
  [/saemtliche/g, "sämtliche"],
  [/Saemtliche/g, "Sämtliche"],
  [/maessig/g, "mäßig"],
  [/Maessig/g, "Mäßig"],
  [/regelmaessig/g, "regelmäßig"],
  [/Regelmaessig/g, "Regelmäßig"],
  [/Maerz/g, "März"],
  [/ergaenzt/g, "ergänzt"],
  [/Ergaenzt/g, "Ergänzt"],
  [/ergaenzen/g, "ergänzen"],
  [/Ergaenzen/g, "Ergänzen"],
  [/ergaenzung/g, "ergänzung"],
  [/Ergaenzung/g, "Ergänzung"],
  [/Praesentation/g, "Präsentation"],
  [/praesentation/g, "präsentation"],
  [/Praezision/g, "Präzision"],
  [/praezise/g, "präzise"],
  [/Praeferenz/g, "Präferenz"],
  [/Praesident/g, "Präsident"],
  [/Praeferenzen/g, "Präferenzen"],
  [/Praefix/g, "Präfix"],
  [/praefix/g, "präfix"],
  [/Praefe/g, "Präfe"],
  [/Benutzeroberflaeche/g, "Benutzeroberfläche"],
  [/Oberflaeche/g, "Oberfläche"],
  [/oberflaeche/g, "oberfläche"],
  [/Faehigkeit/g, "Fähigkeit"],
  [/faehigkeit/g, "fähigkeit"],
  [/Faehigkeiten/g, "Fähigkeiten"],
  [/faehigkeiten/g, "fähigkeiten"],
  [/Quaelitaet/g, "Qualität"], // typo guard
  [/Qualitaet/g, "Qualität"],
  [/qualitaet/g, "qualität"],
  [/Realitaet/g, "Realität"],
  [/realitaet/g, "realität"],
  [/Aktivitaet/g, "Aktivität"],
  [/aktivitaet/g, "aktivität"],
  [/Funktionalitaet/g, "Funktionalität"],
  [/funktionalitaet/g, "funktionalität"],
  [/Stabilitaet/g, "Stabilität"],
  [/Verfuegbarkeit/g, "Verfügbarkeit"],
  [/verfuegbar/g, "verfügbar"],
  [/Verfuegbar/g, "Verfügbar"],
  [/Verfuegung/g, "Verfügung"],
  [/zur Verfuegung/g, "zur Verfügung"],
  [/Beruecksichtigung/g, "Berücksichtigung"],
  [/beruecksichtigt/g, "berücksichtigt"],
  [/Beruecksichtigt/g, "Berücksichtigt"],
  [/beruecksichtigen/g, "berücksichtigen"],
  [/Werkstuecke/g, "Werkstücke"],
  [/Werkstueck/g, "Werkstück"],
  [/Stueck/g, "Stück"],
  [/stueck/g, "stück"],
  [/Stuecke/g, "Stücke"],
  [/zurueckgesetzt/g, "zurückgesetzt"],
  [/zurueckgegeben/g, "zurückgegeben"],
  [/Zurueck/g, "Zurück"],
  [/zurueck/g, "zurück"],
  // NICHT pruefe/Pruefe als generisches Pattern — das matcht den Anfang
  // von `pruefer` (DB-Column-Name) und macht `prüfer` daraus. Schon zweimal
  // dieser Bug. Stattdessen weiter oben gezielte Wörter (Pruefen, Prueft,
  // Pruefung, Pruefer).
  [/geprueft/g, "geprüft"],
  [/Geprueft/g, "Geprüft"],
  [/fuehrt/g, "führt"],
  [/Fuehrt/g, "Führt"],
  [/Kuerzel/g, "Kürzel"],     // note: column name `pruefer_kuerzel` is lowercase + underscore, lookahead safe
  [/abkuerzung/g, "abkürzung"],
  [/Abkuerzung/g, "Abkürzung"],
  [/Schaeden/g, "Schäden"],
  [/schaeden/g, "schäden"],
  [/Schaden/g, "Schaden"], // no umlaut singular
  [/Schaedling/g, "Schädling"],
  [/Plausibilitaet/g, "Plausibilität"],
  [/plausibilitaet/g, "plausibilität"],
  [/Plausibilitaets/g, "Plausibilitäts"],
  [/Stationaer/g, "Stationär"],
  [/stationaer/g, "stationär"],
  [/regulaer/g, "regulär"],
  [/Regulaer/g, "Regulär"],
  [/Regulaere/g, "Reguläre"],
  [/regulaere/g, "reguläre"],
  [/Anfaenger/g, "Anfänger"],
  [/anfaenger/g, "anfänger"],
  [/Auspraegung/g, "Ausprägung"], // dup-safe
  [/auspraegung/g, "ausprägung"],
  [/Kapazitaet/g, "Kapazität"],
  [/kapazitaet/g, "kapazität"],
  [/Aktualitaet/g, "Aktualität"],
  [/Identitaet/g, "Identität"],
  [/Persoenlich/g, "Persönlich"],
  [/Persoenliche/g, "Persönliche"],
  [/persoenliche/g, "persönliche"],
  [/persoenlichen/g, "persönlichen"],
  [/Persoenlichkeit/g, "Persönlichkeit"],
  [/Naechst/g, "Nächst"],
  [/naechst/g, "nächst"],
  [/Naechste/g, "Nächste"],
  [/naechste/g, "nächste"],
  [/spaetestens/g, "spätestens"],
  [/Spaetestens/g, "Spätestens"],
  [/frueher/g, "früher"],
  [/Frueher/g, "Früher"],
  [/Verhaltens/g, "Verhaltens"], // no umlaut
  [/Maennlich/g, "Männlich"],
  [/Erlaeuterung/g, "Erläuterung"],
  [/erlaeuterung/g, "erläuterung"],
  [/Erlaeuterungen/g, "Erläuterungen"],
  [/erlaeutert/g, "erläutert"],
  [/Geltungsbereich/g, "Geltungsbereich"], // no umlaut
  [/Beruecksichtigung/g, "Berücksichtigung"],
  [/Bezeichnung/g, "Bezeichnung"], // no umlaut
  [/Bemerkungen/g, "Bemerkungen"], // no umlaut
  [/Tatsache/g, "Tatsache"], // no umlaut
  [/Erlaubniss/g, "Erlaubniss"], // no umlaut (no double ß rule needed)
  [/Erfuellung/g, "Erfüllung"],
  [/Erfuellungs/g, "Erfüllungs"],
  [/Bedauer/g, "Bedauer"], // no umlaut
  [/Geschaeft/g, "Geschäft"],
  [/geschaeft/g, "geschäft"],
  [/Geschaefts/g, "Geschäfts"],
  [/Geschaeftsregel/g, "Geschäftsregel"],
  [/Geschaeftsregeln/g, "Geschäftsregeln"],
  [/Beschaeftigt/g, "Beschäftigt"],
  [/beschaeftigt/g, "beschäftigt"],
  [/Sortierreihen/g, "Sortierreihen"], // no umlaut
  [/Vergroesserung/g, "Vergrößerung"],
  [/Anhaeng/g, "Anhäng"],
  [/anhaeng/g, "anhäng"],
  [/Anhaengt/g, "Anhängt"],
  [/anhaengt/g, "anhängt"],
  [/Auswaehlen/g, "Auswählen"],
  [/auswaehlen/g, "auswählen"],
  [/ausgewaehlt/g, "ausgewählt"],
  [/Ausgewaehlt/g, "Ausgewählt"],
  [/Waehlen/g, "Wählen"],
  [/waehlen/g, "wählen"],
  [/waehrend/g, "während"],
  [/Waehrend/g, "Während"],
  [/Waehrung/g, "Währung"],
  [/Waehrungs/g, "Währungs"],
  [/Naher/g, "Naher"], // no umlaut
  [/maerzt/g, "märzt"], // edge case
  [/grundsaetzlich/g, "grundsätzlich"],
  [/Grundsaetzlich/g, "Grundsätzlich"],
  [/grundsaetze/g, "grundsätze"],
  [/Grundsaetze/g, "Grundsätze"],
  [/Verstaerkung/g, "Verstärkung"],
  [/Erweiterungs/g, "Erweiterungs"], // no umlaut
  [/Eckpunkte/g, "Eckpunkte"],

  // -ue- Wörter
  [/Schluessel/g, "Schlüssel"],
  [/Pruefberichte/g, "Prüfberichte"],
  [/Pruefbericht/g, "Prüfbericht"],
  [/Drueck/g, "Drück"],
  [/druecken/g, "drücken"],
  [/druckt/g, "druckt"], // no umlaut
  [/Verfuegt/g, "Verfügt"],
  [/verfuegt/g, "verfügt"],
  [/Buehne/g, "Bühne"],
  [/buehnen/g, "bühnen"],
  [/Bruecke/g, "Brücke"],
  [/Bruecken/g, "Brücken"],
  [/Gebuehr/g, "Gebühr"],
  [/Mueglich/g, "Müglich"], // typo guard
  [/abschluessig/g, "abschlüssig"],
  [/Schluss/g, "Schluss"], // no umlaut
  [/Schluessig/g, "Schlüssig"],
  [/schluessig/g, "schlüssig"],
  [/Fuehrung/g, "Führung"],
  [/Fuehrungs/g, "Führungs"],
  [/eigenstaendig/g, "eigenständig"],
  [/Eigenstaendig/g, "Eigenständig"],
  [/Eigenstaendigkeits/g, "Eigenständigkeits"],
  [/eigenstaendigen/g, "eigenständigen"],
  [/abhaengig/g, "abhängig"],
  [/Abhaengig/g, "Abhängig"],
  [/Mannschaftsgefuehl/g, "Mannschaftsgefühl"],
  [/Gefuehl/g, "Gefühl"],
  [/gefuehl/g, "gefühl"],
  [/Buecher/g, "Bücher"],
  [/Buch\b/g, "Buch"],
  [/Stueze/g, "Stüze"],
  [/stuetzt/g, "stützt"],
  [/schuetz/g, "schütz"],
  [/Schuetz/g, "Schütz"],
  [/Schuetzt/g, "Schützt"],
  [/abgeschnuert/g, "abgeschnürt"],
  [/Abgesch/g, "Abgesch"], // no umlaut

  // -oe- Wörter
  [/moecht/g, "möcht"],
  [/Moecht/g, "Möcht"],
  [/loeschen/g, "löschen"],
  [/Loeschen/g, "Löschen"],
  [/Loescht/g, "Löscht"],
  [/oeffnen/g, "öffnen"],
  [/Oeffnen/g, "Öffnen"],
  [/oeffentlich/g, "öffentlich"],
  [/Oeffentlich/g, "Öffentlich"],
  [/Oeffentliche/g, "Öffentliche"],
  [/Geroesch/g, "Geroesch"], // no umlaut
  [/Goesse/g, "Größe"],
  [/Groesse/g, "Größe"],
  [/groesse/g, "größe"],
  [/groessere/g, "größere"],
  [/Hoehe/g, "Höhe"],
  [/hoehe/g, "höhe"],
  [/erhoeht/g, "erhöht"],
  [/Erhoeht/g, "Erhöht"],
  [/Hoehensteuerung/g, "Höhensteuerung"],
  [/Hochstapeln/g, "Hochstapeln"], // no umlaut

  // weitere Aktualisierungen (häufig in technischen Texten)
  [/aktualisier/g, "aktualisier"], // no umlaut
  [/Beruecksichtigung/g, "Berücksichtigung"],
  [/zugehoeriger/g, "zugehöriger"],
  [/zugehoerig/g, "zugehörig"],
  [/Zugehoerige/g, "Zugehörige"],
  [/zugehoerige/g, "zugehörige"],
  [/zugehoerigen/g, "zugehörigen"],
  [/erhoeht/g, "erhöht"],
  [/notiertes/g, "notiertes"], // no umlaut
  [/genau/g, "genau"], // no umlaut


  // ß-Wörter (Substring-Matching, nur ungefährliche)
  [/ausschliesslich/g, "ausschließlich"],
  [/Ausschliesslich/g, "Ausschließlich"],
  [/Schliessen/g, "Schließen"],
  [/schliessen/g, "schließen"],
  [/Schliesst/g, "Schließt"],
  [/schliesst/g, "schließt"],
  [/Schloss/g, "Schloss"], // keine Aenderung
  [/fliessend/g, "fließend"],
  [/Heisst/g, "Heißt"],
  [/heisst/g, "heißt"],
  [/grossen/g, "großen"],
  [/Grossen/g, "Großen"],
  [/Grosse/g, "Große"],
  [/grosse/g, "große"],
  [/Gross\b/g, "Groß"],
  [/gross\b/g, "groß"],
  [/gemaess/g, "gemäß"],
  [/Gemaess/g, "Gemäß"],
  [/Ausgabe/g, "Ausgabe"], // kein Umlaut, Filler
  [/Schluesselsatz/g, "Schlüsselsatz"],

  // nächst / nächste
  [/Naechste/g, "Nächste"],
  [/naechste/g, "nächste"],
  [/naechst/g, "nächst"],

  // begründ
  [/Begruendung/g, "Begründung"],
  [/begruendung/g, "begründung"],
  [/begruenden/g, "begründen"],
  [/begruendet/g, "begründet"],

  // zulässig
  [/Zulaessig/g, "Zulässig"],
  [/zulaessig/g, "zulässig"],

  // Ausprägung
  [/Auspraegungen/g, "Ausprägungen"],
  [/Auspraegung/g, "Ausprägung"],
  [/auspraegung/g, "ausprägung"],

  // Erfüllung
  [/Erfuellung/g, "Erfüllung"],
  [/erfuellung/g, "erfüllung"],
  [/erfuellt/g, "erfüllt"],
  [/Erfuellt/g, "Erfüllt"],

  // weitere häufige Wörter
  // hu_faellig ist eine DB-Spalte — daher (?!_)... wobei hier eher _faellig
  // das Problem ist, nicht faellig_. Aber ein faellig direkt im Identifier
  // kommt nicht vor. Vor dem faellig steht _ — den koennen wir nicht via
  // Lookahead schuetzen, sondern via Lookbehind (?<!_).
  [/(?<!_)Faelligkeit/g, "Fälligkeit"],
  [/(?<!_)faelligkeit/g, "fälligkeit"],
  [/(?<!_)Faellig/g, "Fällig"],
  [/(?<!_)faellig/g, "fällig"],
  [/Geschaeft/g, "Geschäft"],
  [/geschaeft/g, "geschäft"],
  [/Gefaehrlich/g, "Gefährlich"],
  [/gefaehrlich/g, "gefährlich"],
  [/Erheblich/g, "Erheblich"],   // hat kein Umlaut, dient nur Konsistenz
  [/noetig/g, "nötig"],
  [/Noetig/g, "Nötig"],
  [/Loesung/g, "Lösung"],
  [/loesung/g, "lösung"],
  [/Loeschen/g, "Löschen"],
  [/loeschen/g, "löschen"],
  [/Hoehe/g, "Höhe"],
  [/hoehe/g, "höhe"],
  [/Groesse/g, "Größe"],
  [/groesse/g, "größe"],
  [/Schoen/g, "Schön"],
  [/schoen/g, "schön"],
  [/zurueck/g, "zurück"],
  [/Zurueck/g, "Zurück"],
  [/Pruefliste/g, "Prüfliste"],
  [/eigenstaendig/g, "eigenständig"],
  [/Eigenstaendig/g, "Eigenständig"],
  [/Datenstaende/g, "Datenstände"],
  [/Aktenschrank/g, "Aktenschrank"], // kein Umlaut, nur Doku-Konsistenz
  [/Empfang/g, "Empfang"],            // kein Umlaut, nur Doku-Konsistenz

  // Spezial für unsere Doku-Strings
  [/Verkehrssicherheit/g, "Verkehrssicherheit"], // kein Umlaut
  [/Praesentation/g, "Präsentation"],
  [/Aufloesung/g, "Auflösung"],
  [/Sicherheitsgurt/g, "Sicherheitsgurt"], // kein Umlaut

  // ß
  [/strasse/g, "straße"],
  [/Strasse/g, "Straße"],
];

// === Kategorie-Codes ===
// Vorsichtig: HM/LM/GM können auch andere Dinge bedeuten (Kreis-Codes, etc.).
// Daher nur in spezifischen Phrasen ersetzen.
const KATEGORIE_RULES = [
  // Auflistungen wie "OM/LM/EM/HM/GM" oder "OM, LM, EM, HM, GM"
  [/\bOM\/LM\/EM\/HM\/GM\b/g, "OM/GM/EM/GfM"],
  [/\bOM, LM, EM, HM, GM\b/g, "OM, GM, EM, GfM"],
  [/\bOM \| LM \| EM \| HM \| GM\b/g, "OM | GM | EM | GfM"],

  // Bezeichnung-Erklärungen
  [/HM = Hauptmangel/g, "EM = Erheblicher Mangel"],
  [/LM = Leichter Mangel/g, "GM = Geringer Mangel"],
  [/GM = Gefährlicher Mangel/g, "GfM = Gefährlicher Mangel"],
  [/GM = Gefaehrlicher Mangel/g, "GfM = Gefährlicher Mangel"],
];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = relative(ROOT, full).replaceAll(sep, "/");
    if (SKIP_DIRS.has(name)) continue;
    if (SKIP_FILES.has(rel)) continue;
    const s = statSync(full);
    if (s.isDirectory()) out.push(...walk(full));
    else if (FILE_EXTS.has(extname(name))) out.push(full);
  }
  return out;
}

let totalFiles = 0;
let totalReplacements = 0;
const perFile = [];

for (const file of walk(ROOT)) {
  const rel = relative(ROOT, file).replaceAll(sep, "/");
  const before = readFileSync(file, "utf8");
  let after = before;
  let fileReplacements = 0;

  for (const [pat, repl] of [...UMLAUT_RULES, ...KATEGORIE_RULES]) {
    const matches = after.match(pat);
    if (matches) {
      fileReplacements += matches.length;
      after = after.replace(pat, repl);
    }
  }

  if (fileReplacements > 0) {
    totalFiles++;
    totalReplacements += fileReplacements;
    perFile.push({ file: rel, count: fileReplacements });
    if (!DRY) writeFileSync(file, after, "utf8");
  }
}

console.log(`\n${DRY ? "[DRY RUN] " : ""}Refactor abgeschlossen:`);
console.log(`  Dateien geändert: ${totalFiles}`);
console.log(`  Ersetzungen total: ${totalReplacements}\n`);
perFile.sort((a, b) => b.count - a.count);
for (const { file, count } of perFile) {
  console.log(`  ${String(count).padStart(4)} × ${file}`);
}
