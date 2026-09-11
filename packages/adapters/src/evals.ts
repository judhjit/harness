import { randomUUID } from "node:crypto";
import { Application } from "./application.ts";
import { hash } from "./files.ts";
import { referenceWorkflow } from "../../core/src/product.ts";
import type { Ticket } from "../../core/src/contracts.ts";
import { HarnessError } from "../../core/src/contracts.ts";
import { git } from "./commands.ts";
import { command } from "./commands.ts";
import type { GraphProviderConfig } from "../../core/src/graph.ts";

export interface EvalSuite {
  name: string;
  repetitions: number;
  cases: {
    id: string;
    repositoryId: string;
    ticket: Ticket;
    expectedFiles?: string[];
    scorers?: {
      id: string;
      executable: string;
      args: string[];
      timeoutMs: number;
    }[];
  }[];
  variants: {
    id: string;
    graphContext: boolean;
    skills?: Record<string, string>;
    graph?: GraphProviderConfig;
  }[];
}
export class Evaluations {
  app: Application;
  constructor(app: Application) {
    this.app = app;
  }
  async run(suite: EvalSuite, signal?: AbortSignal) {
    if (
      !suite.name ||
      !Array.isArray(suite.cases) ||
      !suite.cases.length ||
      suite.cases.length > 100 ||
      !Array.isArray(suite.variants) ||
      !suite.variants.length ||
      suite.variants.length > 10 ||
      !Number.isInteger(suite.repetitions) ||
      suite.repetitions < 1 ||
      suite.repetitions > 10
    )
      throw new HarnessError("INPUT", "Invalid eval suite bounds");
    const id = randomUUID();
    this.app.store.db
      .prepare("INSERT INTO eval_experiments VALUES(?,?,?,'RUNNING',?)")
      .run(
        id,
        suite.name,
        JSON.stringify({ suite, hash: hash(JSON.stringify(suite)) }),
        new Date().toISOString(),
      );
    try {
      for (const task of suite.cases) {
        const profile = this.app.data.repository(task.repositoryId);
        const base = git(profile.path, ["rev-parse", profile.base]);
        for (let repetition = 0; repetition < suite.repetitions; repetition++)
          for (const variant of repetition % 2
            ? [...suite.variants].reverse()
            : suite.variants) {
            if (signal?.aborted)
              throw new HarnessError("CANCELLED", "Evaluation cancelled");
            const repositoryId = `eval-${id.slice(0, 8)}-${hash(task.id + variant.id).slice(0, 8)}`;
            const workflow = {
              ...(profile.workflow ?? referenceWorkflow),
              id: "evaluation",
              phases: (profile.workflow ?? referenceWorkflow).phases.filter(
                (p) => !["approval", "publish"].includes(p.provider ?? ""),
              ),
            };
            this.app.register({
              ...profile,
              id: repositoryId,
              base,
              workflow,
              skills: { ...profile.skills, ...variant.skills },
              graph: variant.graph ?? profile.graph,
            });
            const started = Date.now();
            let runId: string | undefined;
            let result: any;
            try {
              const run = await this.app.create(
                repositoryId,
                task.ticket,
                variant.graphContext,
                false,
              );
              runId = run.id;
              const completed = await this.app.execute(run.id, signal);
              const verification = completed.verification;
              const found = task.expectedFiles ?? [];
              const changed = completed.candidate?.files ?? [];
              const goldenChecks = [];
              if (completed.status === "COMPLETED")
                for (const scorer of task.scorers ?? []) {
                  const scored = await command(
                    scorer.executable,
                    scorer.args.map((arg) =>
                      arg.replaceAll(
                        "{workspace}",
                        completed.candidate.workspace,
                      ),
                    ),
                    {
                      signal,
                      timeoutMs: scorer.timeoutMs,
                      env: { PATH: process.env.PATH, HOME: process.env.HOME },
                    },
                  );
                  this.app.workspaces.verify(completed.candidate);
                  goldenChecks.push({
                    id: scorer.id,
                    passed: scored.exitCode === 0 && !scored.timedOut,
                    evidence: scored,
                    scorerHash: hash(JSON.stringify(scorer)),
                  });
                }
              result = {
                status: completed.status,
                solved:
                  completed.status === "COMPLETED" &&
                  goldenChecks.length > 0 &&
                  goldenChecks.every((c) => c.passed) &&
                  found.every((f) => changed.includes(f)),
                goldenChecks,
                scored: goldenChecks.length > 0,
                checks: verification?.results ?? [],
                expectedFiles: found,
                matchedFiles: found.filter((f) => changed.includes(f)),
                attempts: completed.phases.reduce((n, p) => n + p.attempts, 0),
                durationMs: Date.now() - started,
                error: completed.error,
                requirementCoverage: completed.review?.criteria ?? [],
                contextBytes: this.app.store
                  .artifacts(run.id)
                  .filter((a) => a.role.startsWith("context"))
                  .reduce((n, a) => n + a.bytes, 0),
              };
            } catch (error) {
              result = {
                status: "ERROR",
                solved: false,
                error: String(error),
                durationMs: Date.now() - started,
              };
            }
            this.app.store.db
              .prepare("INSERT INTO eval_results VALUES(?,?,?,?,?,?,?)")
              .run(
                randomUUID(),
                id,
                task.id,
                variant.id,
                repetition,
                runId ?? null,
                JSON.stringify(result),
              );
          }
      }
      this.app.store.db
        .prepare("UPDATE eval_experiments SET status='COMPLETED' WHERE id=?")
        .run(id);
    } catch (error) {
      this.app.store.db
        .prepare("UPDATE eval_experiments SET status='FAILED' WHERE id=?")
        .run(id);
      throw error;
    }
    return this.get(id);
  }
  list() {
    return this.app.store.db
      .prepare(
        "SELECT id,name,status,created_at FROM eval_experiments ORDER BY created_at DESC",
      )
      .all();
  }
  get(id: string) {
    const experiment = this.app.store.db
      .prepare("SELECT * FROM eval_experiments WHERE id=?")
      .get(id) as any;
    if (!experiment) throw new HarnessError("INPUT", "Unknown experiment");
    const results = this.app.store.db
      .prepare("SELECT * FROM eval_results WHERE experiment_id=?")
      .all(id)
      .map((r: any) => ({ ...r, result: JSON.parse(r.result_json) }));
    const variants = [...new Set(results.map((r) => r.variant))].map(
      (variant) => {
        const rows = results.filter((r) => r.variant === variant);
        return {
          variant,
          total: rows.length,
          solved: rows.filter((r) => r.result.solved).length,
          errors: rows.filter(
            (r) => r.result.status === "ERROR" || r.result.status === "BLOCKED",
          ).length,
          meanDurationMs:
            rows.reduce((n, r) => n + r.result.durationMs, 0) / rows.length,
          meanAttempts:
            rows.reduce((n, r) => n + (r.result.attempts ?? 0), 0) /
            rows.length,
        };
      },
    );
    return {
      ...experiment,
      configuration: JSON.parse(experiment.config_json),
      results,
      variants,
    };
  }
}
