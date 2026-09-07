/**
 * WF-01 Defense-in-Depth: alle drei Verteidigungs-Layer sowie das
 * behoben=TRUE-Verhalten gegen einen laufenden Stack pruefen.
 *
 * Vorbedingung: API + MariaDB muessen laufen (Compose-Stack, CI-Service oder
 * lokales Setup). Wenn nicht, werden die Tests uebersprungen, damit
 * `npm test` lokal ohne DB nicht fehlschlaegt.
 *
 * @vitest-environment node
 */
import "dotenv/config";
import { describe, it, expect, beforeEach } from "vitest";
import { resolveSqlRunner } from "./dbCli.js";

const API = process.env.TUV_API_URL || "http://localhost:8787";

// Pre-flight: pruefen, ob der Docker-Stack laeuft. Top-Level await, weil
// describe.skipIf(...) die Bedingung bei Test-Collection auswertet — wir
// muessen also schon vor der describe-Definition wissen, ob wir skippen.
const stackUp = await (async () => {
  try {
    const r = await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch {
    return false;
  }
})();

async function seedDemo() {
  // X-Admin-Token: im Dev-Modus (leeres ADMIN_TOKEN) ignoriert der Server
  // den Header — gegen eine Production-API ist er Pflicht (401 sonst).
  const r = await fetch(`${API}/api/admin/demo`, {
    method: "POST",
    headers: { "X-Admin-Token": process.env.ADMIN_TOKEN || "" },
  });
  if (!r.ok) throw new Error(`Demo-Seed fehlgeschlagen: HTTP ${r.status}`);
  return r.json();
}

async function listTermine() {
  return fetch(`${API}/api/termine`).then((r) => r.json());
}

async function listMaengel(terminId) {
  return fetch(`${API}/api/termine/${terminId}/maengel`).then((r) => r.json());
}

async function findTerminWithUnbehobenBlocker() {
  for (const t of await listTermine()) {
    const maengel = await listMaengel(t.terminId);
    const blocker = maengel.find(
      (m) => !m.behoben && (m.kategorieCode === "EM" || m.kategorieCode === "GfM"),
    );
    if (blocker) return { termin: t, maengel, blocker };
  }
  throw new Error("Kein Termin mit unbehobenem EM/GfM im Seed gefunden");
}

async function findTerminBestandenMitBehobenBlocker() {
  for (const t of await listTermine()) {
    if (t.statusCode !== "Bestanden") continue;
    const maengel = await listMaengel(t.terminId);
    const onlyBehobenBlocker =
      maengel.length > 0 &&
      maengel.every((m) => m.behoben || (m.kategorieCode !== "EM" && m.kategorieCode !== "GfM"));
    const hasBehobenBlocker = maengel.some(
      (m) => m.behoben && (m.kategorieCode === "EM" || m.kategorieCode === "GfM"),
    );
    if (hasBehobenBlocker && onlyBehobenBlocker) return { termin: t, maengel };
  }
  throw new Error("Kein Bestanden-Termin mit behobenem EM/GfM im Seed gefunden");
}

async function findCleanTermin() {
  for (const t of await listTermine()) {
    if (t.statusCode === "Bestanden") continue;
    const maengel = await listMaengel(t.terminId);
    const hasBlocker = maengel.some(
      (m) => !m.behoben && (m.kategorieCode === "EM" || m.kategorieCode === "GfM"),
    );
    if (!hasBlocker) return { termin: t, maengel };
  }
  throw new Error("Kein Nicht-Bestanden-Termin ohne Blocker im Seed gefunden");
}

beforeEach(async () => {
  if (!stackUp) return;
  await seedDemo();
});

// Layer 3 braucht einen Weg, roh an der API vorbei SQL zu schicken. Welcher
// das ist (Client ueber TCP oder docker exec), entscheidet dbCli.js zur
// Laufzeit. Nur wenn es gar keinen gibt, wird dieser eine Test uebersprungen
// — TUV_SKIP_SQL_BYPASS=1 erzwingt das zusaetzlich von aussen.
const sqlRunner = stackUp && process.env.TUV_SKIP_SQL_BYPASS !== "1" ? resolveSqlRunner() : null;

describe.skipIf(!stackUp)("WF-01 Defense-in-Depth", () => {
  it.skipIf(!sqlRunner)("Layer 3 (DB-Trigger): direkter SQL-UPDATE wird abgelehnt", async () => {
    const { termin } = await findTerminWithUnbehobenBlocker();

    const { exitCode, stderr } = sqlRunner.run(
      `UPDATE termin SET status_code='Bestanden' WHERE termin_id='${termin.terminId}';`,
    );

    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/ERROR 1644.*45000/);
    expect(stderr).toMatch(/WF-01/);

    const after = (await listTermine()).find((t) => t.terminId === termin.terminId);
    expect(after.statusCode).toBe(termin.statusCode);
  });

  // Frueher stand hier ein Test "generischer PATCH liefert HTTP 422": der
  // Endpunkt PATCH /api/termine/:id schrieb status_code mit, lief in den
  // Trigger und der Error-Handler uebersetzte SQLSTATE 45000 in 422.
  //
  // Diese Route nimmt statusCode inzwischen gar nicht mehr an (sie
  // verlangte nur "schreiben" — die Rolle empfang konnte darueber ein
  // Pruefergebnis setzen). Der Fall wird jetzt vor der Datenbank mit
  // HTTP 400 abgelehnt und in server/tests/termin-status-routen.test.js
  // geprueft. Der 45000-auf-422-Mapper in server/index.js bleibt als
  // Sicherheitsnetz bestehen — er greift z. B., wenn zwischen dem
  // Blocker-Check des Status-Endpunkts und dem UPDATE ein blockierender
  // Mangel angelegt wird.

  it("Layer 2 (API-Guard): Status-Endpoint antwortet sauber mit ok:false", async () => {
    const { termin } = await findTerminWithUnbehobenBlocker();

    const res = await fetch(`${API}/api/termine/${termin.terminId}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ statusCode: "Bestanden" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toMatch(/erheblichem|gefährlichem/i);

    const after = (await listTermine()).find((t) => t.terminId === termin.terminId);
    expect(after.statusCode).toBe(termin.statusCode);
  });

  it("Happy Path: Termin ohne blockierenden Mangel darf Bestanden werden", async () => {
    const { termin } = await findCleanTermin();

    const res = await fetch(`${API}/api/termine/${termin.terminId}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ statusCode: "Bestanden" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.termin.statusCode).toBe("Bestanden");
  });

  it("behoben=TRUE-Maengel zaehlen nicht: Demote + Re-Bestanden funktioniert", async () => {
    const { termin } = await findTerminBestandenMitBehobenBlocker();

    const demote = await fetch(`${API}/api/termine/${termin.terminId}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ statusCode: "Geplant" }),
    });
    expect(demote.status).toBe(200);

    const promote = await fetch(`${API}/api/termine/${termin.terminId}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ statusCode: "Bestanden" }),
    });
    expect(promote.status).toBe(200);
    const body = await promote.json();
    expect(body.ok).toBe(true);
    expect(body.termin.statusCode).toBe("Bestanden");
  });

  it("Auto-Demotion: neuer unbehoben EM auf Bestanden-Termin setzt ihn auf Nicht bestanden", async () => {
    // Bestanden-Termin OHNE bestehende Maengel (Array.find mit async geht nicht
    // korrekt — daher hier expliziter Loop).
    const termine = await listTermine();
    let target = null;
    for (const t of termine) {
      if (t.statusCode !== "Bestanden") continue;
      const m = await listMaengel(t.terminId);
      if (m.length === 0) {
        target = t;
        break;
      }
    }
    expect(target).toBeDefined();
    expect(target).not.toBeNull();

    const post = await fetch(`${API}/api/maengel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        terminId: target.terminId,
        codeStvzo: "TEST.WF01",
        beschreibung: "Auto-Demotion-Test (unbehoben EM)",
        kategorieCode: "EM",
        behoben: false,
      }),
    });
    expect(post.status).toBe(201);
    const body = await post.json();
    expect(body.terminDemoted).toBe(true);

    const after = (await listTermine()).find((t) => t.terminId === target.terminId);
    expect(after.statusCode).toBe("Nicht bestanden");
  });

  it("Auto-Demotion: behoben=true blockierender Mangel laesst Termin auf Bestanden", async () => {
    const target = (await listTermine()).find((t) => t.statusCode === "Bestanden");
    expect(target).toBeDefined();

    const post = await fetch(`${API}/api/maengel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        terminId: target.terminId,
        codeStvzo: "TEST.WF01.behoben",
        beschreibung: "Behoben-Test (EM behoben=true)",
        kategorieCode: "EM",
        behoben: true,
      }),
    });
    expect(post.status).toBe(201);
    const body = await post.json();
    expect(body.terminDemoted).toBe(false);

    const after = (await listTermine()).find((t) => t.terminId === target.terminId);
    expect(after.statusCode).toBe("Bestanden");
  });
});

describe.skipIf(stackUp)("WF-01 (Docker-Stack nicht erreichbar — Tests uebersprungen)", () => {
  it.skip("Stack starten mit: docker compose up -d", () => {});
});
