import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileWorkflow } from "../packages/core/src/contracts.ts";
import type { RunConfig } from "../packages/core/src/contracts.ts";
import { hash } from "../packages/adapters/src/files.ts";
import { ProcessRuntime } from "../packages/adapters/src/runtime.ts";

export const fixtureRoot = () =>
  realpathSync(mkdtempSync(join(tmpdir(), "eng-test-")));
export function runtime(root: string, mode = "") {
  return new ProcessRuntime(
    root,
    {
      name: "test-fixture",
      version: "1",
      executableHash: hash("fixture"),
      configHash: hash("fixture"),
      isolation: "test-only",
    },
    (directory) => ({
      command: process.execPath,
      args: [fileURLToPath(new URL("./fixtures/gemini.mjs", import.meta.url))],
      cwd: directory,
      env: { PATH: process.env.PATH!, FIXTURE_MODE: mode },
    }),
  );
}
export async function config(root: string): Promise<RunConfig> {
  return {
    ticket: {
      key: "JIRA-428",
      title: "Add retry",
      description: "Retry transient failure",
      acceptanceCriteria: ["Retry once", "Preserve permanent errors"],
    },
    source: {
      repository: "/fixture",
      revision: "a".repeat(40),
      files: [
        {
          path: "src/service.ts",
          content: "export const retries = 0;",
          hash: hash("export const retries = 0;"),
        },
      ],
      omitted: ["README.md"],
    },
    workflow: compileWorkflow(
      JSON.parse(
        readFileSync(
          new URL("../workflows/pilot-v1.json", import.meta.url),
          "utf8",
        ),
      ),
    ),
    skills: Object.fromEntries(
      ["requirements", "plan"].map((s) => [
        s,
        readFileSync(
          new URL(`../skills/${s}/SKILL.md`, import.meta.url),
          "utf8",
        ),
      ]),
    ),
    runtime: await runtime(root).describe(),
  };
}
