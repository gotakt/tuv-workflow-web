/**
 * Gemeinsame Helfer fuer die E2E-Tests.
 *
 * Grundsatz: die Tests reden mit der Anwendung so, wie die Prüfstelle es tut
 * — ueber die UI. Nur das Herstellen des Ausgangszustands (Demodaten laden)
 * laeuft ueber die API, weil es sonst pro Test eine Minute Klicken waere.
 */
import { expect } from "@playwright/test";

export const API = process.env.E2E_API_URL || `http://127.0.0.1:${process.env.E2E_API_PORT || 8788}`;
export const PASSWORT = "e2e-passwort";

/** Die drei Default-Konten aus server/db.js. */
export const KONTEN = {
  empfang: { kuerzel: "empfang", name: "Empfang", rolle: "Empfang" },
  pruefer: { kuerzel: "MW", name: "Marwan Saleh", rolle: "Prüfer" },
  chef: { kuerzel: "chef", name: "Chef", rolle: "Chef" },
};

/** Login gegen die API (ohne Browser) — liefert den Bearer-Token. */
export async function apiLogin(request, kuerzel = "chef") {
  const res = await request.post(`${API}/api/auth/login`, {
    data: { kuerzel, passwort: PASSWORT },
  });
  expect(res.ok(), `Login als ${kuerzel} fehlgeschlagen: HTTP ${res.status()}`).toBeTruthy();
  return (await res.json()).token;
}

/**
 * Setzt die Datenbank auf den bekannten Demo-Datenstand zurueck.
 *
 * Das ist der Grund, warum die E2E-Suite nicht parallel laeuft: alle Tests
 * teilen sich eine Datenbank. Ein Reseed mitten im Lauf eines anderen Tests
 * wuerde ihm die Termine unter den Fuessen wegziehen.
 */
export async function demoDatenLaden(request) {
  const token = await apiLogin(request, "chef");
  const res = await request.post(`${API}/api/admin/demo`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.ok(), `Demo-Seed fehlgeschlagen: HTTP ${res.status()}`).toBeTruthy();
  return res.json();
}

/** Login durch die echte Login-Maske. */
export async function anmelden(page, kuerzel = "chef") {
  await page.goto("/");
  await page.getByLabel("Kürzel").fill(kuerzel);
  await page.getByLabel("Passwort").fill(PASSWORT);
  await page.getByRole("button", { name: "Anmelden" }).click();
  // Die App-Shell ist da, wenn die Navigation steht.
  await expect(page.getByRole("button", { name: "Tagesplan" })).toBeVisible();
}

/** Wechselt den Tagesplan in die Tabellenansicht ueber alle Termine. */
export async function alleTermineAnzeigen(page) {
  await page.getByRole("button", { name: "Tagesplan" }).click();
  await page.getByRole("button", { name: "Tabelle", exact: true }).click();
  await page.getByRole("button", { name: "Alle Termine" }).click();
  await expect(page.getByText(/Alle Termine — \d+/)).toBeVisible();
}

/** "2026-09-06" -> "06.09.2026" (Anzeigeformat der Tabelle). */
function datumAnzeige(iso) {
  const [j, m, t] = String(iso).slice(0, 10).split("-");
  return `${t}.${m}.${j}`;
}

/** "14:00:00" -> "14:00" */
function zeitAnzeige(uhrzeit) {
  return String(uhrzeit).slice(0, 5);
}

/**
 * Die Tabellenzeile eines Termins.
 *
 * Das Kennzeichen allein reicht nicht: ein Fahrzeug kann mehrere Termine
 * haben, und dann trifft der Filter zwei Zeilen. Ein Test, der in so einem
 * Fall einfach die erste nimmt, prueft irgendwann still den falschen Termin.
 * Deshalb zusaetzlich ueber Datum und Uhrzeit einschraenken, wenn der Termin
 * bekannt ist.
 */
export function terminZeile(page, kennzeichenOderTermin, termin = null) {
  if (typeof kennzeichenOderTermin === "string" && !termin) {
    return page.getByRole("row").filter({ hasText: kennzeichenOderTermin });
  }
  const kennzeichen =
    typeof kennzeichenOderTermin === "string"
      ? kennzeichenOderTermin
      : kennzeichenOderTermin.kennzeichen;
  const t = termin || kennzeichenOderTermin.termin || kennzeichenOderTermin;
  return page
    .getByRole("row")
    .filter({ hasText: kennzeichen })
    .filter({ hasText: datumAnzeige(t.datum) })
    .filter({ hasText: zeitAnzeige(t.uhrzeit) });
}

/** Fahrzeug-ID zu einem Kennzeichen (fuer <select>-Optionen nach Wert). */
export async function fahrzeugIdZuKennzeichen(request, kennzeichen) {
  const token = await apiLogin(request, "chef");
  const fahrzeuge = await (
    await request.get(`${API}/api/fahrzeuge`, { headers: { Authorization: `Bearer ${token}` } })
  ).json();
  const fz = fahrzeuge.find((f) => f.kennzeichen === kennzeichen);
  if (!fz) throw new Error(`Fahrzeug ${kennzeichen} nicht gefunden`);
  return fz.fahrzeugId;
}

/**
 * Liest ueber die API einen Termin, der einen offenen EM- oder GfM-Mangel
 * hat. Die Demodaten sind zufaellig genug, dass ein fest verdrahtetes
 * Kennzeichen im Test bei jeder Seed-Aenderung brechen wuerde.
 */
export async function terminMitBlockierendemMangel(request) {
  const token = await apiLogin(request, "chef");
  const headers = { Authorization: `Bearer ${token}` };
  const termine = await (await request.get(`${API}/api/termine`, { headers })).json();
  const fahrzeuge = await (await request.get(`${API}/api/fahrzeuge`, { headers })).json();

  for (const t of termine) {
    const maengel = await (
      await request.get(`${API}/api/termine/${t.terminId}/maengel`, { headers })
    ).json();
    const blocker = maengel.find(
      (m) => !m.behoben && (m.kategorieCode === "EM" || m.kategorieCode === "GfM"),
    );
    if (blocker) {
      const fz = fahrzeuge.find((f) => f.fahrzeugId === t.fahrzeugId);
      return { termin: t, maengel, blocker, kennzeichen: fz?.kennzeichen };
    }
  }
  throw new Error("Kein Termin mit offenem EM/GfM in den Demodaten gefunden");
}

/** Termin ohne blockierenden Mangel, der noch nicht bestanden ist. */
export async function terminOhneBlocker(request) {
  const token = await apiLogin(request, "chef");
  const headers = { Authorization: `Bearer ${token}` };
  const termine = await (await request.get(`${API}/api/termine`, { headers })).json();
  const fahrzeuge = await (await request.get(`${API}/api/fahrzeuge`, { headers })).json();

  for (const t of termine) {
    if (t.statusCode === "Bestanden") continue;
    const maengel = await (
      await request.get(`${API}/api/termine/${t.terminId}/maengel`, { headers })
    ).json();
    const blocker = maengel.some(
      (m) => !m.behoben && (m.kategorieCode === "EM" || m.kategorieCode === "GfM"),
    );
    if (!blocker) {
      const fz = fahrzeuge.find((f) => f.fahrzeugId === t.fahrzeugId);
      return { termin: t, kennzeichen: fz?.kennzeichen };
    }
  }
  throw new Error("Kein blockerfreier Termin in den Demodaten gefunden");
}
