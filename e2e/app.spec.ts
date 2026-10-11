import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";

const xssFixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/xss.json");

async function ready(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Resolve" })).toBeVisible();
  await expect(page.getByLabel("Library counts")).toContainText("Example · mock · not a live Figma file", {
    timeout: 30_000,
  });
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
  await expect(page.getByRole("region", { name: "Library overview" }).getByText("Example", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Library counts")).toContainText("Example · mock · not a live Figma file");
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

test("a failed rules call shows an error, not the example rules", async ({ page }) => {
  await page.route("**/api/governance", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "down" }),
    }),
  );
  await page.goto("/");
  await page.getByRole("tab", { name: "Rules" }).click();
  const alert = page.getByRole("alert").filter({ hasText: "Could not load the rules" });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("Next: Reload the page.");
  await expect(page.getByText("Pay CTA")).toHaveCount(0);
  await expect(page.getByText("Shared DS")).toHaveCount(0);
  await expect(page.getByText(/Sample from/)).toHaveCount(0);
});

test("a failed scoreboard call shows an error, not a sample score", async ({ page }) => {
  await page.route("**/api/scoreboard**", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "down" }),
    }),
  );
  await page.goto("/");
  const alert = page.getByRole("region", { name: "Scoreboard" }).getByRole("alert");
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("Could not load the scoreboard.");
  await expect(alert).toContainText("Next: Run npm run resolve -- score phrases");
  await expect(page.getByRole("region", { name: "Scoreboard" }).getByText("100%")).toHaveCount(0);
});

test("a failed Figma load does not keep the example library on screen", async ({ page }) => {
  await page.route("**/api/figma/**", (route) =>
    route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ err: "Token expired" }),
    }),
  );
  await ready(page);
  await page.getByRole("button", { name: "Load Figma" }).click();
  await page.getByLabel("File URL or key").fill("https://www.figma.com/design/ACMEUI/Acme");
  await page.getByLabel("Personal access token").fill("figd_example");
  await page.getByRole("button", { name: "Ingest" }).click();
  await expect(page.getByRole("heading", { name: "Library did not ingest" })).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: "Figma authentication failed" })).toHaveCount(2);
  await expect(page.getByRole("alert").filter({ hasText: "example library is not shown" })).toHaveCount(2);
  await expect(page.getByRole("heading", { name: "Demo Pay — Product" })).toHaveCount(0);
  await expect(page.getByText("Example · mock · not a live Figma file")).toHaveCount(0);
});

test("axe has no critical or serious violations", async ({ page }) => {
  await ready(page);
  const library = await new AxeBuilder({ page }).disableRules(["color-contrast"]).analyze();
  const bad = library.violations.filter((item) => item.impact === "critical" || item.impact === "serious");
  expect(bad, JSON.stringify(bad.map((item) => item.id))).toEqual([]);
});
