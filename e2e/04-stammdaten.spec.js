/**
 * Journey 4 — Fahrzeug erfassen und Termin anlegen.
 *
 * Der Alltag am Empfang: ein Kunde ruft an, das Fahrzeug ist neu, ein Termin
 * muss in den Kalender. Geprueft wird auch der unangenehme Teil — dass
 * ungueltige Eingaben nicht in die Datenbank durchrutschen.
 */
import { test, expect } from "@playwright/test";
import {
  demoDatenLaden,
  anmelden,
  alleTermineAnzeigen,
  terminZeile,
  fahrzeugIdZuKennzeichen,
} from "./hilfen.js";

test.beforeEach(async ({ request }) => {
  await demoDatenLaden(request);
});

/** Eindeutiges Kennzeichen pro Lauf — sonst kollidiert der UNIQUE-Index. */
function kennzeichenErzeugen() {
  const n = String(Math.floor(Math.random() * 9000) + 1000);
  return `H-QA ${n}`;
}

test("leeres Fahrzeug-Formular: Pflichtfeld-Fehler, nichts wird gespeichert", async ({ page }) => {
  await anmelden(page, "empfang");
  await page.getByRole("button", { name: "Fahrzeuge" }).click();
  await page.getByRole("button", { name: "Fahrzeug erfassen" }).click();

  const dialog = page.getByRole("dialog", { name: "Fahrzeug neu erfassen" });
  await dialog.getByRole("button", { name: "Fahrzeug erfassen" }).click();

  // exact: true ist hier wichtig — ohne das zaehlt der Untertitel des
  // Dialogs ("Pflichtfelder sind mit * markiert") als fuenfter Treffer mit.
  await expect(dialog.getByText("Pflichtfeld", { exact: true })).toHaveCount(4);
  await expect(dialog).toBeVisible();
});

test("ungültiger Kreis-Code im Kennzeichen wird abgelehnt", async ({ page }) => {
  await anmelden(page, "empfang");
  await page.getByRole("button", { name: "Fahrzeuge" }).click();
  await page.getByRole("button", { name: "Fahrzeug erfassen" }).click();

  const dialog = page.getByRole("dialog", { name: "Fahrzeug neu erfassen" });
  await dialog.getByLabel("Kennzeichen *").fill("ZZZ-AB 123");
  await dialog.getByLabel("Hersteller *").selectOption("__SONSTIGER__");
  await dialog.getByPlaceholder("z. B. Tatra, Lada, Tuning-Werkstatt").fill("Tatra");
  await dialog.getByLabel("Modell / Variante *").fill("815");
  await dialog.getByLabel("Name / Firma *").fill("QA Testhalter");
  await dialog.getByRole("button", { name: "Fahrzeug erfassen" }).click();

  await expect(dialog.getByText(/kein gültiger Kreis-Code/)).toBeVisible();
  await expect(dialog).toBeVisible();
});

test("Fahrzeug erfassen und Termin dafür anlegen", async ({ page, request }) => {
  const kennzeichen = kennzeichenErzeugen();

  await anmelden(page, "empfang");
  await page.getByRole("button", { name: "Fahrzeuge" }).click();
  await page.getByRole("button", { name: "Fahrzeug erfassen" }).click();

  const fzDialog = page.getByRole("dialog", { name: "Fahrzeug neu erfassen" });
  await fzDialog.getByLabel("Kennzeichen *").fill(kennzeichen);
  await fzDialog.getByLabel("Hersteller *").selectOption("__SONSTIGER__");
  await fzDialog.getByPlaceholder("z. B. Tatra, Lada, Tuning-Werkstatt").fill("Tatra");
  await fzDialog.getByLabel("Modell / Variante *").fill("815 QA");
  await fzDialog.getByLabel("Name / Firma *").fill("QA Testhalter");
  await fzDialog.getByRole("button", { name: "Fahrzeug erfassen" }).click();

  await expect(fzDialog).toHaveCount(0);
  await expect(page.getByText(kennzeichen).first()).toBeVisible();

  // Termin fuer genau dieses Fahrzeug anlegen.
  await page.getByRole("button", { name: "Tagesplan" }).click();
  await page.getByRole("button", { name: "Termin anlegen" }).click();

  const trDialog = page.getByRole("dialog", { name: "Prüftermin anlegen" });
  // Die Option-Beschriftung setzt sich aus Kennzeichen, Hersteller, Modell
  // und Halter zusammen. Statt sie nachzubauen (und bei jeder Formatierungs-
  // aenderung zu brechen) ueber den Wert waehlen — die Fahrzeug-ID.
  const fahrzeugId = await fahrzeugIdZuKennzeichen(request, kennzeichen);
  await trDialog.getByLabel("Fahrzeug *").selectOption(fahrzeugId);
  await trDialog.getByLabel("Uhrzeit").selectOption("09:30");
  await trDialog.getByLabel("Art der Prüfung").selectOption("AU");
  await trDialog.getByRole("button", { name: "Termin anlegen" }).click();

  await expect(trDialog).toHaveCount(0);

  // Nach einem Neuladen muss der Termin immer noch da sein — das trennt
  // "im React-State" von "in MariaDB".
  await page.reload();
  await alleTermineAnzeigen(page);
  await expect(terminZeile(page, kennzeichen)).toHaveCount(1);
  await expect(terminZeile(page, kennzeichen).getByText("Geplant")).toBeVisible();
  await expect(terminZeile(page, kennzeichen).getByText("09:30")).toBeVisible();
});

test("Status ist beim Anlegen gesperrt und steht auf 'Geplant'", async ({ page }) => {
  await anmelden(page, "chef");
  await page.getByRole("button", { name: "Termin anlegen" }).click();

  const dialog = page.getByRole("dialog", { name: "Prüftermin anlegen" });
  const status = dialog.getByLabel("Status");
  await expect(status).toBeDisabled();
  await expect(status).toHaveValue("Geplant");
});
