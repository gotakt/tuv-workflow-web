/**
 * Journey 5 — Berichte und Statistik.
 *
 * Das Ende der Kette: was in der Halle erfasst wurde, muss der Chef als
 * Bericht und als Auswertung wiederfinden. Ein Bericht, der die Mängel des
 * Termins nicht zeigt, ist schlimmer als kein Bericht.
 */
import { test, expect } from "@playwright/test";
import { demoDatenLaden, anmelden, terminMitBlockierendemMangel } from "./hilfen.js";

test.beforeAll(async ({ request }) => {
  await demoDatenLaden(request);
});

test("Berichtsliste zeigt geprüfte Fahrzeuge und öffnet eine Vorschau", async ({
  page,
  request,
}) => {
  const { kennzeichen, blocker } = await terminMitBlockierendemMangel(request);

  await anmelden(page, "chef");
  await page.getByRole("button", { name: "Berichte" }).click();

  // Suche einschraenken, damit die Vorschau eindeutig zum Termin gehoert.
  await page.getByPlaceholder("Suche...").fill(kennzeichen);
  await expect(page.getByText(kennzeichen).first()).toBeVisible();

  await page.getByRole("button", { name: "Vorschau" }).first().click();
  const dialog = page.getByRole("dialog", { name: `Bericht: ${kennzeichen}` });
  await expect(dialog).toBeVisible();

  // Der erfasste Mangel muss im Bericht stehen — sonst unterschreibt der
  // Chef ein Dokument, das den Befund verschweigt.
  await expect(dialog.getByText(new RegExp(blocker.beschreibung.slice(0, 20)))).toBeVisible();
});

test("Suche ohne Treffer zeigt einen leeren Zustand statt einer leeren Seite", async ({ page }) => {
  await anmelden(page, "chef");
  await page.getByRole("button", { name: "Berichte" }).click();
  await page.getByPlaceholder("Suche...").fill("XX-QQ 9999");

  await expect(page.getByText("Keine Einträge gefunden")).toBeVisible();
});

test("Statistik lädt und zeigt Kennzahlen", async ({ page }) => {
  await anmelden(page, "chef");
  await page.getByRole("button", { name: "Statistik" }).click();

  // Die Kennzahlen aus StatistikView — nicht irgendein Text, sondern die
  // vier Kacheln, die der Chef morgens anschaut.
  // first(): "Bestandsquote" steht auch in zwei Diagramm-Ueberschriften.
  await expect(page.getByText("Prüfungen gesamt").first()).toBeVisible();
  await expect(page.getByText("Bestandsquote").first()).toBeVisible();
  await expect(page.getByText("HU überfällig").first()).toBeVisible();
  await expect(page.locator("svg.recharts-surface").first()).toBeVisible();
});
