import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";

const xssFixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/xss.json");

async function ready(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Resolve" })).toBeVisible();
  await expect(page.getByText(/source: (figma-mcp|mock)/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("tab", { name: "Library" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("Library counts")).toBeVisible();
}

test("mock graph loads without credentials", async ({ page }) => {
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  await ready(page);
  await page.getByLabel("Data source").selectOption("mock:demo-pay");
  await expect(page.getByRole("heading", { name: "Demo Pay — Product" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText("source: mock")).toBeVisible();
  await expect(page.getByRole("region", { name: "Library overview" })).toBeVisible();
  await expect(page.locator(".atlas__canvas")).toHaveCount(0);
  await expect(page.locator(".react-flow")).toHaveCount(0);
  expect(dialogs).toEqual([]);
});

test("XSS payloads render as text, not HTML", async ({ page }) => {
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  await ready(page);
  await page.locator('input[type="file"]').setInputFiles(xssFixture);
  await expect(page.getByRole("heading", { name: "<img src=x onerror=alert(1)>" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.locator("script", { hasText: "alert(1)" })).toHaveCount(0);
  await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0);
  expect(dialogs).toEqual([]);
});

test("keyboard can switch to Rules", async ({ page }) => {
  await ready(page);
  await page.getByRole("tab", { name: "Rules" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("tab", { name: "Rules" })).toHaveAttribute("aria-selected", "true");
});

test("axe has no critical or serious violations", async ({ page }) => {
  await ready(page);
  const library = await new AxeBuilder({ page }).disableRules(["color-contrast"]).analyze();
  const bad = library.violations.filter((item) => item.impact === "critical" || item.impact === "serious");
  expect(bad, JSON.stringify(bad.map((item) => item.id))).toEqual([]);
});
