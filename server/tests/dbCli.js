/**
 * Waehlt einen Weg, rohes SQL an der API vorbei gegen die Datenbank zu
 * schicken — fuer die Layer-3-Tests (DB-Trigger), die genau das pruefen
 * muessen, was ein Angreifer oder ein verirrtes DB-Tool tun wuerde.
 *
 * Frueher war das fest auf `docker exec tuv-mariadb` verdrahtet. Damit lief
 * der wichtigste WF-01-Test nur auf einem laufenden Compose-Stack; in der CI
 * (MariaDB als Service-Container, kein Compose) musste er per
 * TUV_SKIP_SQL_BYPASS uebersprungen werden. Ein Defense-Layer, der in der
 * Pipeline nie geprueft wird, ist kein geprueter Layer.
 *
 * Reihenfolge:
 *   1. Direkter MariaDB/MySQL-Client ueber TCP (CI, lokales Setup ohne Docker)
 *   2. `docker exec <container> mariadb ...` (Compose-Stack)
 *   3. null — Aufrufer skippt mit klarer Begruendung
 */
import { execFileSync } from "node:child_process";

const HOST = process.env.MARIADB_HOST || "127.0.0.1";
const PORT = process.env.MARIADB_PORT || "3306";
const USER = process.env.MARIADB_USER || "tuv_app";
const PASSWORD = process.env.MARIADB_PASSWORD || "tuv_app_pw";
const DATABASE = process.env.MARIADB_DATABASE || "tuv_workflow";
const CONTAINER = process.env.TUV_DB_CONTAINER || "tuv-mariadb";

// Passwort per MYSQL_PWD statt -p<pw>: sonst schreibt der Client bei jedem
// Aufruf eine "Using a password on the command line interface can be
// insecure"-Warnung nach stderr — und die Tests pruefen stderr.
const pwEnv = { ...process.env, MYSQL_PWD: PASSWORD };

/**
 * Fuehrt ein Kommando aus und liefert immer ein Ergebnis-Objekt statt zu
 * werfen. exitCode 0 = SQL durchgelaufen, != 0 = abgelehnt (das ist bei den
 * Trigger-Tests der Erfolgsfall).
 */
function capture(fn) {
  try {
    const stdout = fn();
    return { exitCode: 0, stdout: String(stdout || ""), stderr: "" };
  } catch (err) {
    return {
      exitCode: err.status ?? 1,
      stdout: String(err.stdout || ""),
      stderr: String(err.stderr || err.message || ""),
    };
  }
}

function clientRunner(bin) {
  const args = ["-h", HOST, "-P", String(PORT), "-u", USER, DATABASE, "-e"];
  return {
    label: `${bin} @ ${HOST}:${PORT}`,
    run: (sql) =>
      capture(() =>
        execFileSync(bin, [...args, sql], {
          stdio: ["ignore", "pipe", "pipe"],
          env: pwEnv,
        }),
      ),
  };
}

// execFileSync statt execSync: kein Shell-Prozess dazwischen, also auch
// keine Moeglichkeit, dass ein Anfuehrungszeichen im SQL oder ein
// Sonderzeichen im Passwort aus dem Argument ausbricht. Die alte Fassung in
// wf01.test.js baute die Kommandozeile als String zusammen und wurde von
// CodeQL zu Recht als js/command-line-injection gemeldet — mit
// JSON.stringify als Notbehelf fuer das Quoting. Ein Argument-Array braucht
// gar kein Quoting.
function dockerRunner() {
  return {
    label: `docker exec ${CONTAINER}`,
    run: (sql) =>
      capture(() =>
        execFileSync(
          "docker",
          [
            "exec",
            "-e",
            `MYSQL_PWD=${PASSWORD}`,
            CONTAINER,
            "mariadb",
            "-u",
            USER,
            DATABASE,
            "-e",
            sql,
          ],
          { stdio: ["ignore", "pipe", "pipe"] },
        ),
      ),
  };
}

/**
 * @returns {{label: string, run: (sql: string) => {exitCode: number, stdout: string, stderr: string}} | null}
 */
export function resolveSqlRunner() {
  const candidates = process.env.TUV_DB_CLI
    ? [process.env.TUV_DB_CLI]
    : ["mariadb", "mysql"];

  for (const bin of candidates) {
    const runner = clientRunner(bin);
    // Probe-Query: schlaegt fehl, wenn das Binary nicht existiert ODER die
    // Verbindung nicht steht. Beides bedeutet "dieser Weg geht nicht".
    if (runner.run("SELECT 1;").exitCode === 0) return runner;
  }

  const docker = dockerRunner();
  if (docker.run("SELECT 1;").exitCode === 0) return docker;

  return null;
}
