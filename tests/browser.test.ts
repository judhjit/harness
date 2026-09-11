import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";
import { Application } from "../packages/adapters/src/application.ts";
import { createApi } from "../apps/server/src/server.ts";
import { fixtureRoot } from "./helpers.ts";

const executable =
  process.env.ENG_CHROME ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
test(
  "browser authenticates and navigates the locally bundled product",
  {
    skip:
      !existsSync(executable) ||
      !existsSync(new URL("../apps/web/dist/app.js", import.meta.url)),
  },
  async () => {
    const app = new Application(fixtureRoot());
    const server = createApi(app, "browser-fixture-token");
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const browser = await chromium.launch({
      executablePath: executable,
      headless: true,
    });
    const page = await browser.newPage({
      viewport: { width: 1400, height: 1000 },
    });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    try {
      await page.goto(`http://127.0.0.1:${(server.address() as any).port}`);
      await page
        .getByLabel("Local session token")
        .fill("browser-fixture-token");
      await page
        .getByRole("button", { name: "Connect to workstation" })
        .click();
      await page
        .getByRole("heading", { name: "Start an engineering run" })
        .waitFor();
      await page.getByRole("button", { name: "Graph", exact: true }).click();
      await page
        .getByRole("heading", { name: "External graph provider" })
        .waitFor();
      await page
        .getByRole("button", { name: "Repositories", exact: true })
        .click();
      await page
        .getByRole("heading", { name: "Repository profile", exact: true })
        .waitFor();
      await page.getByRole("button", { name: "Runs", exact: true }).click();
      await page.screenshot({
        path: "/private/tmp/engineering-harness-ui.png",
        fullPage: true,
      });
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      app.close();
    }
  },
);
