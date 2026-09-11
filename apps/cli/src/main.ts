import { parseArgs } from "node:util";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compileWorkflow,
  validateTicket,
  HarnessError,
} from "../../../packages/core/src/contracts.ts";
import { Coordinator } from "../../../packages/core/src/coordinator.ts";
import { SqliteStore } from "../../../packages/adapters/src/sqlite.ts";
import { GeminiCliRuntime } from "../../../packages/adapters/src/runtime.ts";
import {
  hash,
  redact,
  sourceSnapshot,
} from "../../../packages/adapters/src/files.ts";
import { productCli } from "./product.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const help = `Engineering Harness — planning slice (Node 24.13+)

eng serve [--port 4310] [--origin https://your-private-forwarded-host]
eng doctor
eng repo add profile.json
eng run JIRA-428 --repo registered-id [--ticket ticket.json]
eng resume RUN_ID
eng graph search-text --repo registered-id
eng eval run suite.json
eng approve APPROVAL_ID --hash SUBJECT_HASH

node apps/cli/src/main.ts run JIRA-428 --repo /repo --ticket ticket.json --files src/a.ts --runtime runtime.json
node apps/cli/src/main.ts status ENG-2026-000001
node apps/cli/src/main.ts logs ENG-2026-000001 [--after 0]
node apps/cli/src/main.ts resume ENG-2026-000001 --runtime runtime.json
node apps/cli/src/main.ts cancel ENG-2026-000001
node apps/cli/src/main.ts artifact ENG-2026-000001 --artifact <id>

All commands: --data /canonical/local/path (default .harness), --json
Runtime config is trusted workstation configuration, never repository content.
Run reads selected committed files into bounded context; it does not implement code.
`;
if (!(await productCli(process.argv.slice(2)))) {
  let store: SqliteStore | undefined;
  try {
    const { values, positionals } = parseArgs({
      allowPositionals: true,
      options: {
        repo: { type: "string" },
        ticket: { type: "string" },
        files: { type: "string" },
        runtime: { type: "string" },
        data: { type: "string" },
        json: { type: "boolean" },
        help: { type: "boolean" },
        after: { type: "string" },
        artifact: { type: "string" },
      },
    });
    const [command, identifier] = positionals;
    if (values.help || !command) {
      console.log(help);
    } else {
      if (
        !["run", "status", "logs", "resume", "cancel", "artifact"].includes(
          command,
        ) ||
        !identifier ||
        positionals.length !== 2
      )
        throw new HarnessError("INPUT", help);
      store = new SqliteStore(resolve(values.data ?? ".harness"));
      const print = (value: unknown) =>
        console.log(JSON.stringify(value, null, values.json ? 0 : 2));
      if (command === "run" || command === "resume") {
        if (!values.runtime)
          throw new HarnessError("INPUT", "--runtime is required");
        const runtimeConfig = JSON.parse(readFileSync(values.runtime, "utf8"));
        const targetRepo =
          command === "run"
            ? values.repo
              ? realpathSync(values.repo)
              : undefined
            : JSON.parse(store.get(identifier).config_json).source.repository;
        const runtime = new GeminiCliRuntime(
          store.root,
          runtimeConfig,
          targetRepo ? [targetRepo] : [],
        );
        let run;
        if (command === "run") {
          if (!values.repo || !values.ticket || !values.files)
            throw new HarnessError(
              "INPUT",
              "--repo, --ticket and --files are required",
            );
          const repo = realpathSync(values.repo);
          if (realpathSync(values.runtime).startsWith(repo + "/"))
            throw new HarnessError(
              "POLICY",
              "Runtime config must be outside the target repository",
            );
          const ticket = validateTicket(
            JSON.parse(readFileSync(values.ticket, "utf8")),
          );
          if (ticket.key !== identifier)
            throw new HarnessError(
              "INPUT",
              "Ticket key does not match command",
            );
          const source = sourceSnapshot(repo, values.files.split(","));
          const config = {
            ticket,
            source,
            workflow: compileWorkflow(
              JSON.parse(
                readFileSync(join(root, "workflows/pilot-v1.json"), "utf8"),
              ),
            ),
            skills: Object.fromEntries(
              ["requirements", "plan"].map((name) => [
                name,
                readFileSync(join(root, `skills/${name}/SKILL.md`), "utf8"),
              ]),
            ),
            runtime: await runtime.describe(),
          };
          if (redact(JSON.stringify(config)) !== JSON.stringify(config))
            throw new HarnessError(
              "POLICY",
              "Potential secret detected in run inputs",
            );
          run = store.create(config);
          console.error(`Created ${run.display_id}`);
        } else run = store.get(identifier);
        const controller = new AbortController();
        const cancel = () => controller.abort();
        process.once("SIGINT", cancel);
        process.once("SIGTERM", cancel);
        let cursor = store.events(run.id).at(-1)?.sequence ?? 0;
        const output = setInterval(() => {
          if (values.json) return;
          for (const event of store!.events(run.id, cursor)) {
            cursor = event.sequence;
            if (!event.type.startsWith("AGENT_"))
              console.error(
                `${event.sequence} ${event.type} ${event.phase_id ?? ""}`,
              );
          }
        }, 200);
        try {
          const completed = await new Coordinator(store, runtime, hash).resume(
            run.id,
            controller.signal,
          );
          print({
            id: completed.display_id,
            status: completed.status,
            error: completed.error,
            phases: store.phases(run.id),
            artifacts: store.artifacts(run.id),
          });
          process.exitCode =
            completed.status === "COMPLETED"
              ? 0
              : completed.status === "CANCELLED"
                ? 130
                : 1;
        } finally {
          clearInterval(output);
          process.removeListener("SIGINT", cancel);
          process.removeListener("SIGTERM", cancel);
        }
      } else {
        const run = store.get(identifier);
        if (command === "status")
          print({
            id: run.display_id,
            status: run.status,
            error: run.error,
            cancellationRequested: !!run.cancel_requested,
            phases: store.phases(run.id),
            artifacts: store.artifacts(run.id),
          });
        if (command === "logs") {
          const after = Number(values.after ?? 0);
          if (!Number.isSafeInteger(after) || after < 0)
            throw new HarnessError(
              "INPUT",
              "--after must be a nonnegative integer",
            );
          for (const event of store.events(run.id, after)) print(event);
        }
        if (command === "cancel") {
          store.requestCancel(run.id);
          print({
            id: run.display_id,
            cancellationRequested: !!store.get(run.id).cancel_requested,
            instruction:
              "Active coordinator will stop; otherwise resume to reconcile cancellation",
          });
        }
        if (command === "artifact") {
          const artifact = store
            .artifacts(run.id)
            .find((a) => a.id === values.artifact);
          if (!artifact)
            throw new HarnessError(
              "INPUT",
              "Use --artifact with an artifact ID belonging to this run",
            );
          console.log(store.read(artifact));
        }
      }
    }
  } catch (error) {
    console.error(
      redact(error instanceof Error ? error.message : String(error)),
    );
    process.exitCode = 1;
  } finally {
    store?.close();
  }
}
