import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "../packages/adapters/src/commands.ts";
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
    const repo = fixtureRoot();
    writeFileSync(join(repo, "value.cjs"), "module.exports=0;\n");
    git(repo, ["init", "-b", "main"]);
    git(repo, ["add", "."]);
    git(repo, [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@local",
      "commit",
      "-m",
      "base",
    ]);
    app.register({
      id: "ui-pilot",
      path: repo,
      checks: [
        {
          id: "test",
          executable: process.execPath,
          args: ["-e", "process.exit(0)"],
          required: true,
          timeoutMs: 5000,
        },
      ],
    });
    const workspaceFile = join(fixtureRoot(), "browser.code-workspace");
    writeFileSync(workspaceFile, JSON.stringify({ folders: [{ path: repo }] }));
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
      await page
        .getByRole("button", { name: "Workspaces", exact: true })
        .click();
      await page.getByLabel("New workspace ID").fill("browser-product");
      await page.getByLabel("Local .code-workspace path").fill(workspaceFile);
      await page
        .getByRole("button", { name: "Import folders", exact: true })
        .click();
      await page
        .getByRole("status")
        .filter({ hasText: "Only folders imported" })
        .waitFor();
      const workspace = app.data.workspaceGroups()[0];
      await page
        .getByLabel("Workspace profile JSON")
        .fill(
          JSON.stringify({
            ...workspace,
            checks: [
              {
                id: "contract",
                executable: process.execPath,
                args: ["-e", "process.exit(0)"],
                cwdRepository: "ui-pilot",
                required: true,
                timeoutMs: 5000,
              },
            ],
          }),
        );
      await page
        .getByRole("button", { name: "Save workspace", exact: true })
        .click();
      await page
        .getByRole("status")
        .filter({ hasText: "Workspace profile saved" })
        .waitFor();
      await page.getByRole("button", { name: "Runs", exact: true }).click();
      await page
        .getByLabel("Workspace group (optional)")
        .selectOption("browser-product");
      await page.getByLabel("Jira ticket", { exact: true }).fill("ENG-20");
      await page
        .getByPlaceholder("Requirements and acceptance criteria…")
        .fill("Shared browser fixture ticket");
      await page
        .getByRole("button", { name: "Start run", exact: true })
        .click();
      await page
        .getByRole("heading", { name: "Repository candidates and linked PRs" })
        .waitFor();
      assert.equal(app.data.listRuns().length, 1);
      assert.equal(app.data.listRuns()[0].workspaceId, "browser-product");
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
