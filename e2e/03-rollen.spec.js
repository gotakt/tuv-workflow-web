/**
 * Journey 3 — Rollen und Rechte.
 *
 * Die Rechte-Matrix aus dem README ist eine Zusage an den Kunden: der
 * Empfang plant Termine, aber unterschreibt keine Prüfergebnisse. Hier wird
 * beides geprueft — dass die Oberflaeche die Aktion gar nicht erst anbietet
 * UND dass der Server sie ablehnt, wenn man sie trotzdem schickt.
 *
 * Nur das Zweite zaehlt fuer die Sicherheit. Eine ausgeblendete Schaltflaeche
 * haelt niemanden auf, der die API direkt anspricht.
 */
import { test, expect } from "@playwright/test";
import {
  demoDatenLaden,
  anmelden,
  alleTermineAnzeigen,
  terminZeile,
  terminOhneBlocker,
  apiLogin,
  API,
} from "./hilfen.js";

test.beforeEach(async ({ request }) => {
  await demoDatenLaden(request);
});

test("Empfang sieht keine Ergebnis-Schaltflächen und kann keine Mängel erfassen", async ({
  page,
  request,
}) => {
  const { kennzeichen, termin } = await terminOhneBlocker(request);

  await anmelden(page, "empfang");
  await alleTermineAnzeigen(page);
  await terminZeile(page, kennzeichen, termin)
    .getByRole("button", { name: "Mängel erfassen" })
    .click();

  const dialog = page.getByRole("dialog", { name: "Mängelerfassung" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Prüfergebnis setzen")).toHaveCount(0);
  await expect(dialog.getByText(/Mängel können nur von Prüfern erfasst/)).toBeVisible();
});

test("Empfang sieht keine Löschen-Schaltfläche im Tagesplan", async ({ page, request }) => {
  const { kennzeichen, termin } = await terminOhneBlocker(request);

  await anmelden(page, "empfang");
  await alleTermineAnzeigen(page);
  await expect(
    terminZeile(page, kennzeichen, termin).getByRole("button", { name: "Löschen" }),
  ).toHaveCount(0);
});

test("Chef sieht die Löschen-Schaltfläche", async ({ page, request }) => {
  const { kennzeichen, termin } = await terminOhneBlocker(request);

  await anmelden(page, "chef");
  await alleTermineAnzeigen(page);
  await expect(
    terminZeile(page, kennzeichen, termin).getByRole("button", { name: "Löschen" }),
  ).toBeVisible();
});

test("Server lehnt einen Statuswechsel des Empfangs auch ohne UI ab", async ({ request }) => {
  const { termin } = await terminOhneBlocker(request);
  const token = await apiLogin(request, "empfang");

  const res = await request.patch(`${API}/api/termine/${termin.terminId}/status`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { statusCode: "Bestanden" },
  });
  expect(res.status()).toBe(403);

  // Und der Status ist unveraendert geblieben.
  const chefToken = await apiLogin(request, "chef");
  const termine = await (
    await request.get(`${API}/api/termine`, {
      headers: { Authorization: `Bearer ${chefToken}` },
    })
  ).json();
  const danach = termine.find((t) => t.terminId === termin.terminId);
  expect(danach.statusCode).toBe(termin.statusCode);
});

test("Server lehnt einen Löschversuch des Prüfers ab", async ({ request }) => {
  const { termin } = await terminOhneBlocker(request);
  const token = await apiLogin(request, "MW");

  const res = await request.delete(`${API}/api/termine/${termin.terminId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(403);
});

test("ohne Token liefert die API 401 statt Daten", async ({ request }) => {
  const res = await request.get(`${API}/api/termine`);
  expect(res.status()).toBe(401);
});
