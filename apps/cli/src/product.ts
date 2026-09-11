import { parseArgs } from "node:util";
import { readFileSync, existsSync, mkdirSync, cpSync } from "node:fs";
import { resolve, join } from "node:path";
import { Application } from "../../../packages/adapters/src/application.ts";
import { Evaluations } from "../../../packages/adapters/src/evals.ts";
import { serve } from "../../server/src/server.ts";
import { InternalClient } from "../../../packages/adapters/src/integrations.ts";
import {
  sanitize,
  processIdentity,
} from "../../../packages/adapters/src/files.ts";
import { HarnessError } from "../../../packages/core/src/contracts.ts";

export async function productCli(args: string[]): Promise<boolean> {
  const commands = [
    "serve",
    "terminal",
    "doctor",
    "repo",
    "workspace",
    "integration",
    "graph",
    "eval",
    "approve",
    "comments",
    "backup",
  ];
  const routed =
    commands.includes(args[0]) ||
    (["run", "resume"].includes(args[0]) && !args.includes("--runtime"));
  if (!routed) return false;
  let app: Application | undefined;
  try {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        data: { type: "string" },
        repo: { type: "string" },
        workspace: { type: "string" },
        profile: { type: "string" },
        ticket: { type: "string" },
        port: { type: "string" },
        origin: { type: "string", multiple: true },
        hash: { type: "string" },
        reject: { type: "boolean" },
        "graph-context": { type: "boolean" },
        json: { type: "boolean" },
        operation: { type: "string" },
        help: { type: "boolean" },
        terminal: { type: "boolean" },
      },
    });
    const [cmd, arg, extra] = positionals;
    const root = resolve(values.data ?? ".harness");
    const print = (value: unknown) =>
      console.log(JSON.stringify(sanitize(value), null, 2));
    if (cmd === "serve") {
      await serve(root, Number(values.port ?? 4310), values.origin ?? []);
      return true;
    }
    app = new Application(root);
    if (cmd === "terminal" || values.terminal) {
      if (!process.stdin.isTTY || !process.stdout.isTTY)
        throw new Error(
          "Open a real VS Code terminal: interactive Gemini cannot run through a pipe or the browser worker",
        );
      app.terminalAttached = true;
    }
    if (cmd === "doctor") print(await app.doctor());
    else if (cmd === "repo") {
      if (arg === "list") print(app.data.repositories());
      else if (arg === "add" && extra)
        print(app.register(JSON.parse(readFileSync(extra, "utf8"))));
      else throw new Error("Usage: eng repo add profile.json | eng repo list");
    } else if (cmd === "workspace") {
      if (arg === "list") print(app.data.workspaceGroups());
      else if (arg === "add" && extra)
        print(app.multi.register(JSON.parse(readFileSync(extra, "utf8"))));
      else if (arg === "import" && extra && positionals[3])
        print(app.multi.importWorkspace(extra, positionals[3]));
      else
        throw new Error(
          "Usage: eng workspace list | add profile.json | import GROUP_ID file.code-workspace",
        );
    } else if (cmd === "integration") {
      if (arg === "list") print(app.data.integrations());
      else if (arg === "add" && extra) {
        const config = JSON.parse(readFileSync(extra, "utf8"));
        new InternalClient(config);
        app.data.saveIntegration(config);
        print({ saved: config.id });
      } else throw new Error("Usage: eng integration add profile.json | list");
    } else if (cmd === "run") {
      const repository = values.profile ?? values.repo;
      if (
        (!repository && !values.workspace) ||
        (repository && values.workspace) ||
        !arg
      )
        throw new Error(
          "Usage: eng run JIRA-428 (--repo registered-id | --workspace group-id) [--ticket ticket.json] [--graph-context]",
        );
      const ticket = values.ticket
        ? JSON.parse(readFileSync(values.ticket, "utf8"))
        : { key: arg };
      if (ticket.key !== arg) throw new Error("Ticket key mismatch");
      const run = values.workspace
        ? app.multi.create(
            values.workspace,
            ticket,
            !!values["graph-context"],
            false,
          )
        : await app.create(
            repository!,
            ticket,
            !!values["graph-context"],
            false,
          );
      console.error(`Created ${run.display_id}`);
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      try {
        const result = await app.execute(run.id, controller.signal);
        print(result);
        process.exitCode = ["COMPLETED", "WAITING"].includes(result.status)
          ? 0
          : 1;
      } finally {
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
      }
    } else if (cmd === "resume" || cmd === "terminal") {
      if (!arg) throw new Error("Run ID required");
      if (
        cmd === "terminal" &&
        ["FAILED", "CANCELLED", "COMPLETED"].includes(app.store.get(arg).status)
      )
        throw new Error(
          "This run is terminal; start a new run for an interactive workflow",
        );
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      try {
        print(await app.execute(arg, controller.signal));
      } finally {
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
      }
    } else if (cmd === "approve") {
      if (!arg || !values.hash)
        throw new Error(
          "Usage: eng approve approval-id --hash subject-hash [--reject]",
        );
      app.approve(arg, values.hash, values.reject ? "REJECTED" : "APPROVED");
      print({
        recorded: true,
        note: "Run is queued; eng serve will continue it, or use eng resume.",
      });
    } else if (cmd === "comments") {
      if (arg === "publish" && extra) print(await app.publishComments(extra));
      else if (arg && extra) print(app.proposeComments(arg, extra.split(",")));
      else
        throw new Error(
          "Usage: eng comments RUN_ID finding-id,other-id | eng comments publish APPROVAL_ID",
        );
    } else if (cmd === "graph") {
      if (!values.repo) throw new Error("--repo registered-id is required");
      print(
        await app.graph(values.repo, {
          operation: (values.operation ?? "search") as any,
          query: arg,
          nodeId: arg,
        }),
      );
    } else if (cmd === "eval") {
      const evals = new Evaluations(app);
      if (arg === "run" && extra)
        print(await evals.run(JSON.parse(readFileSync(extra, "utf8"))));
      else if (arg === "compare" && extra) print(evals.get(extra));
      else if (arg === "list") print(evals.list());
      else
        throw new Error(
          "Usage: eng eval run suite.json | compare experiment-id | list",
        );
    } else if (cmd === "backup") {
      if (!arg) throw new Error("Usage: eng backup /new/absolute/destination");
      const destination = resolve(arg);
      if (
        existsSync(destination) ||
        destination === root ||
        destination.startsWith(root + "/")
      )
        throw new Error(
          "Backup destination must be new and outside the data root",
        );
      for (const row of app.store.db
        .prepare(
          "SELECT owner_pid,owner_identity FROM runs WHERE owner IS NOT NULL",
        )
        .all() as any[])
        if (processIdentity(row.owner_pid) === row.owner_identity)
          throw new Error("Stop active coordinators before backup");
      app.store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      app.close();
      app = undefined;
      cpSync(root, destination, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
      print({
        backup: destination,
        note: "Keep the server stopped during backup and restore.",
      });
    }
  } catch (error) {
    console.error(String(error));
    process.exitCode = 1;
  } finally {
    app?.close();
  }
  return true;
}
