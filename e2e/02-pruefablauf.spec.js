/**
 * Journey 2 — der Prüfablauf: Termin → Prüfung → Mangel → Ergebnis.
 *
 * Das ist das Geschaeftsversprechen der Software. Wenn hier etwas kaputt
 * geht, unterschreibt eine Prüfstelle ein falsches Prüfergebnis — das ist
 * kein UI-Bug mehr, das ist ein Haftungsfall (§ 29 StVZO).
 *
 * Anders als src/tests/flows/wf01Status.test.jsx laeuft hier nichts gegen
 * einen Mock: der Klick geht durch React, ueber HTTP an Express, durch die
 * Rechtepruefung und in MariaDB.
 *
 * Wichtig dabei: die Klick-Journeys pruefen den Client-Guard (Layer 1). Sie
 * koennen den Server-Guard gar nicht ausloesen, weil die Oberflaeche die
 * gesperrte Aktion nie abschickt. Das wurde beim Schreiben dieser Datei
 * gemessen: mit absichtlich ausgebautem Server-Guard blieb die Suite gruen.
 * Deshalb der letzte Test — er schickt die Anfrage an der Oberflaeche vorbei.
 */
import { test, expect } from "@playwright/test";
import {
  demoDatenLaden,
  anmelden,
  alleTermineAnzeigen,
  terminZeile,
  terminMitBlockierendemMangel,
  terminOhneBlocker,
  apiLogin,
  API,
} from "./hilfen.js";

test.beforeEach(async ({ request }) => {
  await demoDatenLaden(request);
});

test("offener Hauptmangel: 'Bestanden' ist gesperrt und bleibt es", async ({ page, request }) => {
  const { kennzeichen, termin } = await terminMitBlockierendemMangel(request);

  await anmelden(page, "MW"); // Prüfer
  await alleTermineAnzeigen(page);
  await terminZeile(page, kennzeichen, termin)
    .getByRole("button", { name: "Mängel erfassen" })
    .click();

  const dialog = page.getByRole("dialog", { name: "Mängelerfassung" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/Hauptmangel vorhanden — nicht bestanden/)).toBeVisible();

  const bestanden = dialog.getByRole("button", { name: "Bestanden", exact: true });
  await expect(bestanden).toBeDisabled();
  await expect(bestanden).toHaveAttribute("title", /§ 29 StVZO/);

  // Gegenprobe auf der Datenseite: der Status darf sich nicht bewegt haben.
  await page.getByRole("button", { name: "Schließen" }).first().click();
  await expect(terminZeile(page, kennzeichen, termin).getByText(termin.statusCode)).toBeVisible();
});

test("Mangel erfassen: neuer Hauptmangel sperrt ein bereits bestandenes Ergebnis", async ({
  page,
  request,
}) => {
  const { kennzeichen, termin } = await terminOhneBlocker(request);

  await anmelden(page, "MW");
  await alleTermineAnzeigen(page);
  await terminZeile(page, kennzeichen, termin)
    .getByRole("button", { name: "Mängel erfassen" })
    .click();

  const dialog = page.getByRole("dialog", { name: "Mängelerfassung" });
  await expect(dialog).toBeVisible();

  // Erst bestehen lassen — das muss ohne Blocker funktionieren. Die
  // Bestaetigung kommt als Toast; die gruene Mangel-Zusammenfassung im Dialog
  // gibt es nur, wenn ueberhaupt Maengel erfasst sind, und das ist hier
  // gerade nicht der Fall.
  await dialog.getByRole("button", { name: "Bestanden", exact: true }).click();
  await expect(page.getByText("Status: Bestanden")).toBeVisible();

  // Jetzt einen erheblichen Mangel per Freitext erfassen.
  await dialog.getByRole("button", { name: "Freitext" }).click();
  await dialog.getByLabel("Kategorie").selectOption("EM");
  await dialog
    .getByPlaceholder("Freitext-Beschreibung des Mangels...")
    .fill("E2E: Bremsleitung durchgerostet");
  await dialog.getByRole("button", { name: "Mangel hinzufügen" }).click();

  // Der Server stuft den Termin daraufhin selbst zurueck (Auto-Demotion) und
  // die Oberflaeche muss das zeigen — sonst glaubt der Prüfer weiterhin an
  // ein bestandenes Fahrzeug.
  await expect(dialog.getByText(/Hauptmangel vorhanden — nicht bestanden/)).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Bestanden", exact: true })).toBeDisabled();

  await page.getByRole("button", { name: "Schließen" }).first().click();
  await expect(terminZeile(page, kennzeichen, termin).getByText("Nicht bestanden")).toBeVisible();
});

test("Mangel entfernen gibt 'Bestanden' wieder frei", async ({ page, request }) => {
  const { kennzeichen, termin } = await terminMitBlockierendemMangel(request);

  await anmelden(page, "MW");
  await alleTermineAnzeigen(page);
  await terminZeile(page, kennzeichen, termin)
    .getByRole("button", { name: "Mängel erfassen" })
    .click();

  const dialog = page.getByRole("dialog", { name: "Mängelerfassung" });
  await expect(dialog.getByRole("button", { name: "Bestanden", exact: true })).toBeDisabled();

  // Alle erfassten Maengel entfernen, bis kein Hauptmangel mehr uebrig ist.
  const entfernen = dialog.getByRole("button", { name: "Mangel entfernen" });
  for (let versuche = 0; (await entfernen.count()) > 0 && versuche < 20; versuche += 1) {
    await entfernen.first().click();
  }

  // Ohne Maengel verschwindet die Zusammenfassung ganz — entscheidend ist,
  // dass die Sperre weg ist.
  await expect(dialog.getByText(/Hauptmangel vorhanden/)).toHaveCount(0);
  const bestanden = dialog.getByRole("button", { name: "Bestanden", exact: true });
  await expect(bestanden).toBeEnabled();

  await bestanden.click();
  await page.getByRole("button", { name: "Schließen" }).first().click();
  await expect(terminZeile(page, kennzeichen, termin).getByText("Bestanden")).toBeVisible();

  // Und wirklich in der Datenbank angekommen, nicht nur im React-State:
  await page.reload();
  await alleTermineAnzeigen(page);
  await expect(terminZeile(page, kennzeichen, termin).getByText("Bestanden")).toBeVisible();
});

test("Server lehnt 'Bestanden' auch dann ab, wenn die Oberfläche umgangen wird", async ({
  request,
}) => {
  const { termin } = await terminMitBlockierendemMangel(request);
  const token = await apiLogin(request, "MW"); // Prüfer darf Status setzen

  const res = await request.patch(`${API}/api/termine/${termin.terminId}/status`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { statusCode: "Bestanden" },
  });

  // Der Prüfer hat das Recht, Status zu setzen — abgelehnt wird also nicht
  // wegen fehlender Rechte, sondern wegen des offenen Hauptmangels.
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(false);
  expect(body.reason).toMatch(/erheblichem|gefährlichem/i);

  // Und der Status in der Datenbank ist unveraendert.
  const termine = await (
    await request.get(`${API}/api/termine`, { headers: { Authorization: `Bearer ${token}` } })
  ).json();
  expect(termine.find((t) => t.terminId === termin.terminId).statusCode).toBe(termin.statusCode);
});
