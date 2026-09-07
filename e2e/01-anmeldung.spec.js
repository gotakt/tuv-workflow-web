/**
 * Journey 1 — Anmeldung.
 *
 * Der erste Schritt jedes Arbeitstages in der Prüfstelle. Geprueft wird
 * gegen den echten Server: falsche Zugangsdaten muessen scheitern, richtige
 * muessen die App oeffnen, und Abmelden muss die Sitzung wirklich beenden —
 * nicht nur die Oberflaeche wechseln.
 */
import { test, expect } from "@playwright/test";
import { demoDatenLaden, anmelden, KONTEN, PASSWORT } from "./hilfen.js";

test.beforeAll(async ({ request }) => {
  await demoDatenLaden(request);
});

test("falsche Zugangsdaten werden abgelehnt, die App bleibt zu", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Kürzel").fill("chef");
  await page.getByLabel("Passwort").fill("falsches-passwort");
  await page.getByRole("button", { name: "Anmelden" }).click();

  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByLabel("Kürzel")).toBeVisible();
  await expect(page.getByRole("button", { name: "Tagesplan" })).toHaveCount(0);
});

test("unbekanntes Kürzel wird abgelehnt", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Kürzel").fill("gibtesnicht");
  await page.getByLabel("Passwort").fill(PASSWORT);
  await page.getByRole("button", { name: "Anmelden" }).click();

  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("button", { name: "Tagesplan" })).toHaveCount(0);
});

for (const [schluessel, konto] of Object.entries(KONTEN)) {
  test(`Anmeldung als ${schluessel}: Name und Rolle stehen in der Topbar`, async ({ page }) => {
    await anmelden(page, konto.kuerzel);
    // Beim Konto "empfang" sind Anzeigename und Rollenname identisch — die
    // Topbar zeigt dann zweimal denselben Text. first()/last() trennt Name
    // (oben) von Rolle (darunter), ohne auf CSS-Klassen zu zielen.
    await expect(page.getByText(konto.name, { exact: true }).first()).toBeVisible();
    await expect(page.getByText(konto.rolle, { exact: true }).last()).toBeVisible();
  });
}

test("Abmelden beendet die Sitzung — Neuladen zeigt wieder den Login", async ({ page }) => {
  await anmelden(page, "chef");
  await page.getByRole("button", { name: "Abmelden" }).click();
  await expect(page.getByLabel("Kürzel")).toBeVisible();

  // Der entscheidende Teil: nach einem Reload darf kein Token mehr greifen.
  // Ein Logout, der nur den React-State leert, faellt genau hier auf.
  await page.reload();
  await expect(page.getByLabel("Kürzel")).toBeVisible();
  await expect(page.getByRole("button", { name: "Tagesplan" })).toHaveCount(0);
});
