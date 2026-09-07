/**
 * Journey 6 — Bedienung auf dem Tablet.
 *
 * Der Prüfer steht an der Grube und hat ein Tablet in der Hand, keinen
 * Desktop. Das README verspricht Bedienbarkeit ab 360 px; dieser Test macht
 * daraus eine geprüfte Aussage: Navigation erreichbar, Tagesplan lesbar,
 * kein horizontales Scrollen des Seitenkörpers.
 *
 * Laeuft nur im Playwright-Projekt "tablet" (siehe playwright.config.js).
 */
import { test, expect } from "@playwright/test";
import { demoDatenLaden, anmelden } from "./hilfen.js";

test.beforeAll(async ({ request }) => {
  await demoDatenLaden(request);
});

test("Anmeldung und Navigation funktionieren auf dem Tablet", async ({ page }) => {
  await anmelden(page, "MW");

  await page.getByRole("button", { name: "Fahrzeuge" }).click();
  await expect(page.getByRole("button", { name: "Fahrzeug erfassen" })).toBeVisible();

  await page.getByRole("button", { name: "Tagesplan" }).click();
  await expect(page.getByRole("button", { name: "Termin anlegen" })).toBeVisible();
});

test("die Seite scrollt nicht horizontal", async ({ page }) => {
  await anmelden(page, "MW");

  const ueberlauf = await page.evaluate(() => {
    const b = document.documentElement;
    return b.scrollWidth - b.clientWidth;
  });
  // Ein paar Pixel Toleranz fuer Rundungen bei Geraeteskalierung.
  expect(ueberlauf).toBeLessThanOrEqual(2);
});
