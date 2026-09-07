import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-End-Tests: echter Browser, echtes Vite-Frontend, echte Express-API,
 * echte MariaDB. Nichts ist gemockt.
 *
 * Abgrenzung zu den bestehenden Tests:
 *   src/tests/flows/  — UI gegen einen gemockten apiClient (schnell, isoliert)
 *   server/tests/     — API gegen echte DB, ohne Browser
 *   e2e/              — die ganze Kette, so wie die Prüfstelle sie benutzt
 *
 * Die drei Ebenen finden unterschiedliche Fehler. Ein Vertragsbruch zwischen
 * Frontend und API (falscher Feldname, geaenderte Antwortform) faellt nur
 * hier auf: die Flow-Tests glauben dem Mock, die Server-Tests sehen den
 * Browser nicht.
 *
 * Voraussetzung: eine erreichbare MariaDB (docker compose up -d db, ein
 * lokal installierter Server oder der CI-Service).
 */

// Eigene Ports statt der Entwicklungs-Ports 8787/5173: auf einer
// Entwickler-Maschine laeuft dort oft schon etwas anderes. Ein E2E-Lauf, der
// versehentlich gegen einen fremden Dienst testet, ist schlimmer als einer,
// der gar nicht startet — er wird gruen oder rot aus den falschen Gruenden.
const API_PORT = process.env.E2E_API_PORT || "8788";
const WEB_PORT = process.env.E2E_WEB_PORT || "5174";

// Auth ist in den E2E-Tests bewusst AN — im Dev-Default waere sie aus. Ohne
// Login liessen sich die Rollen-Journeys (Empfang darf kein Pruefergebnis
// setzen) gar nicht pruefen, und genau die sind das Geschaeftsversprechen.
const E2E_ENV = {
  NODE_ENV: "development",
  API_PORT,
  AUTH_ENABLED: "true",
  AUTH_SECRET: "e2e-secret-nur-fuer-tests-mindestens-32-zeichen",
  DEFAULT_USER_PASSWORT: "e2e-passwort",
  MARIADB_HOST: process.env.MARIADB_HOST || "127.0.0.1",
  MARIADB_PORT: process.env.MARIADB_PORT || "3306",
  MARIADB_USER: process.env.MARIADB_USER || "tuv_app",
  MARIADB_PASSWORD: process.env.MARIADB_PASSWORD || "tuv_app_pw",
  MARIADB_DATABASE: process.env.MARIADB_DATABASE || "tuv_e2e",
};

// Die Spezifikationen sprechen die API teilweise direkt an (Rollen-Journeys).
// Sie lesen E2E_API_URL — hier einmal zentral gesetzt, damit Browser-Pfad und
// direkter API-Pfad garantiert dieselbe Instanz treffen.
process.env.E2E_API_URL ||= `http://127.0.0.1:${API_PORT}`;

export default defineConfig({
  testDir: "./e2e",
  // Die Tests teilen sich eine Datenbank und setzen sie pro Datei neu auf.
  // Parallel laufende Dateien wuerden sich gegenseitig die Daten wegziehen —
  // dasselbe Problem, das vite.config.js fuer die Server-Tests loest.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI
    ? [["list"], ["html", { open: "never" }]]
    : [["list"]],

  use: {
    baseURL: process.env.E2E_BASE_URL || `http://127.0.0.1:${WEB_PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    locale: "de-DE",
    timezoneId: "Europe/Berlin",
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      // Der Tablet-Journey gehoert ins Projekt "tablet" — sonst liefe er
      // zweimal, einmal davon mit einem Desktop-Viewport, fuer den er nichts
      // aussagt.
      testIgnore: /mobil\.spec\.js/,
    },
    // Die Prüfer bedienen die App auf dem Tablet in der Halle. Der mobile
    // Aufbau (Sidebar als Overlay) ist damit nicht nur behauptet, sondern in
    // mindestens einem Journey belegt.
    //
    // Bewusst Chromium mit Tablet-Viewport statt eines iPad-Profils: das
    // wuerde WebKit laden (zweiter Browser-Download in jeder Pipeline) und
    // die Aussage waere trotzdem nur "Safari-Engine", nicht "iPad". Was hier
    // geprueft wird, ist das Layout bei 820 px mit Touch — nichts weiter.
    {
      name: "tablet",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 820, height: 1180 },
        hasTouch: true,
        isMobile: true,
      },
      testMatch: /mobil\.spec\.js/,
    },
  ],

  webServer: [
    {
      command: "node server/index.js",
      url: `http://127.0.0.1:${API_PORT}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: E2E_ENV,
    },
    {
      // --host 127.0.0.1: ohne das bindet Vite nur an ::1 (IPv6) und der
      // Health-Check auf 127.0.0.1 laeuft in einen Timeout.
      command: `npm run dev -- --port ${WEB_PORT} --strictPort --host 127.0.0.1`,
      url: `http://127.0.0.1:${WEB_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      // Sonst proxyt der Dev-Server /api weiter auf den Standard-Port 8787 —
      // also an der Test-API vorbei, moeglicherweise auf einen fremden Dienst.
      env: { VITE_API_PROXY_TARGET: `http://127.0.0.1:${API_PORT}` },
    },
  ],
});
