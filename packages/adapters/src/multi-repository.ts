import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Application } from "./application.ts";
import type {
  WorkspaceGroup,
  RepositoryProfile,
  Candidate,
} from "../../core/src/product.ts";
import type {
  RunConfig,
  Ticket,
  Phase,
  PhaseHandler,
  AgentRuntime,
} from "../../core/src/contracts.ts";
import {
  HarnessError,
  Waiting,
  compileWorkflow,
} from "../../core/src/contracts.ts";
import { Coordinator } from "../../core/src/coordinator.ts";
import { git } from "./commands.ts";
import { hash, sanitize } from "./files.ts";
import { ProcessRuntime } from "./runtime.ts";
import { TicketIntake } from "./ticket-intake.ts";

// VS Code workspace files are JSON with comments and trailing commas, not scripts.
export function parseWorkspaceJson(text: string): any {
  let clean = "",
    string = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (string) {
      clean += c;
      if (c === "\\") clean += text[++i] ?? "";
      else if (c === '"') string = false;
    } else if (c === '"') {
      string = true;
      clean += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      clean += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) throw new Error("Unterminated workspace comment");
      i = end + 1;
      clean += " ";
    } else clean += c;
  }
  let json = "";
  string = false;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (string) {
      json += c;
      if (c === "\\") json += clean[++i] ?? "";
      else if (c === '"') string = false;
    } else if (c === '"') {
      string = true;
      json += c;
    } else if (c !== "," || !/^\s*[}\]]/.test(clean.slice(i + 1))) json += c;
  }
  return JSON.parse(json.replace(/^\uFEFF/, ""));
}

export class MultiRepository {
  app: Application;
  constructor(app: Application) {
    this.app = app;
  }
  register(input: WorkspaceGroup): WorkspaceGroup {
    if (
      !input ||
      !/^[a-zA-Z][\w-]{0,63}$/.test(input.id) ||
      !input.name ||
      !Array.isArray(input.repositories) ||
      !input.repositories.length ||
      input.repositories.length > 12
    )
      throw new HarnessError(
        "INPUT",
        "Workspace needs an ID, name and 1–12 repositories",
      );
    const known = new Set<string>(),
      paths = new Set<string>();
    const repositories = input.repositories.map((member) => {
      const p = this.app.data.repository(member.repositoryId);
      const path = realpathSync(git(p.path, ["rev-parse", "--show-toplevel"]));
      const dependencies = member.dependsOn ?? [];
      if (
        known.has(p.id) ||
        paths.has(path) ||
        !Array.isArray(dependencies) ||
        new Set(dependencies).size !== dependencies.length ||
        dependencies.some((id) => !known.has(id))
      )
        throw new HarnessError(
          "INPUT",
          "Use unique Git repositories; dependencies must precede their consumers",
        );
      if (
        member.task !== undefined &&
        (typeof member.task !== "string" || member.task.length > 20000)
      )
        throw new HarnessError(
          "INPUT",
          "Repository task must be text under 20 KB",
        );
      known.add(p.id);
      paths.add(path);
      return {
        repositoryId: p.id,
        dependsOn: dependencies,
        ...(member.task ? { task: member.task } : {}),
      };
    });
    const checks = input.checks ?? [];
    if (
      !Array.isArray(checks) ||
      checks.length > 12 ||
      new Set(checks.map((c) => c.id)).size !== checks.length
    )
      throw new HarnessError(
        "INPUT",
        "Use up to 12 uniquely named cross-repository checks",
      );
    for (const c of checks) {
      if (
        !c.id ||
        !c.executable ||
        typeof c.executable !== "string" ||
        !Array.isArray(c.args) ||
        c.args.some((a) => typeof a !== "string") ||
        typeof c.required !== "boolean" ||
        !known.has(c.cwdRepository) ||
        !Number.isInteger(c.timeoutMs) ||
        c.timeoutMs < 100 ||
        c.timeoutMs > 1800000 ||
        c.dockerImage ||
        c.report ||
        c.minTests !== undefined
      )
        throw new HarnessError(
          "INPUT",
          "Cross checks require explicit host commands, cwdRepository, timeout and required flag; report/Docker options are not supported",
        );
      for (const arg of c.args)
        for (const match of arg.matchAll(/\{workspace:([^}]+)\}/g))
          if (!known.has(match[1]))
            throw new HarnessError(
              "INPUT",
              `Unknown workspace placeholder: ${match[1]}`,
            );
    }
    if (checks.reduce((sum, c) => sum + c.timeoutMs, 0) > 1700000)
      throw new HarnessError(
        "INPUT",
        "Total cross-check timeout must stay below 1,700 seconds",
      );
    const group = { id: input.id, name: input.name, repositories, checks };
    this.app.data.saveWorkspace(group);
    return group;
  }
  importWorkspace(id: string, file: string) {
    if (this.app.data.workspaceGroups().some((g) => g.id === id))
      throw new HarnessError(
        "INPUT",
        "Workspace ID already exists; edit its profile instead",
      );
    if (!/^[a-zA-Z][\w-]{0,63}$/.test(id))
      throw new HarnessError("INPUT", "Invalid workspace ID");
    const text = readFileSync(file, "utf8");
    if (Buffer.byteLength(text) > 500000)
      throw new HarnessError("INPUT", "Workspace file exceeds 500 KB");
    const parsed = parseWorkspaceJson(text);
    if (
      !Array.isArray(parsed.folders) ||
      !parsed.folders.length ||
      parsed.folders.length > 12
    )
      throw new HarnessError(
        "INPUT",
        "Workspace must contain 1–12 local repository folders",
      );
    // Resolve every folder before writing anything. URI and variable expansion are intentionally unsupported.
    const paths: string[] = parsed.folders.map((f: any) => {
      if (typeof f.path !== "string" || f.uri || f.path.includes("${"))
        throw new HarnessError(
          "INPUT",
          "Only literal local folder paths are supported",
        );
      const path = realpathSync(resolve(dirname(resolve(file)), f.path));
      if (realpathSync(git(path, ["rev-parse", "--show-toplevel"])) !== path)
        throw new HarnessError(
          "INPUT",
          "Each workspace folder must be a Git repository root",
        );
      return path as string;
    });
    if (new Set(paths).size !== paths.length)
      throw new HarnessError("INPUT", "Duplicate repository folders");
    const profiles = this.app.data.repositories();
    const resolved = paths.map((path: string) => {
      const matches = profiles.filter((p) => realpathSync(p.path) === path);
      if (matches.length > 1)
        throw new HarnessError(
          "INPUT",
          "Multiple profiles match a folder; create a workspace profile explicitly",
        );
      const repositoryId = `repo-${basename(path)
        .replace(/[^\w-]/g, "-")
        .slice(0, 35)}-${hash(path).slice(0, 10)}`;
      if (!matches.length && profiles.some((p) => p.id === repositoryId))
        throw new HarnessError("INPUT", "Imported profile ID collision");
      return { path, existing: matches[0], repositoryId };
    });
    const workspace = this.app.store.transaction(() => {
      const repositories = resolved.map(({ path, existing, repositoryId }) => ({
        repositoryId:
          existing?.id ??
          this.app.register({ id: repositoryId, path, name: basename(path) })
            .id,
        dependsOn: [],
      }));
      return this.register({ id, name: id, repositories, checks: [] });
    });
    return {
      workspace,
      needsConfiguration: resolved
        .filter((r) => !r.existing)
        .map((r) => r.repositoryId),
      note: "Only folders imported. Configure repository checks/skills and cross-repository checks before running; VS Code tasks/settings were ignored.",
    };
  }
  create(
    workspaceId: string,
    ticket: Partial<Ticket> & { key: string },
    graphContext = false,
    enqueue = true,
  ) {
    const group = this.app.data
      .workspaceGroups()
      .find((g) => g.id === workspaceId);
    if (!group) throw new HarnessError("INPUT", "Unknown workspace group");
    // Revalidate current profiles, then freeze all workflow/skill/base inputs before allocating the run.
    this.register(group);
    if (!group.checks.some((c) => c.required))
      throw new HarnessError(
        "INPUT",
        "Configure at least one required cross-repository check",
      );
    const members = group.repositories.map((member) => {
      const profile = this.app.data.repository(member.repositoryId);
      if (!profile.checks.some((c) => c.required))
        throw new HarnessError(
          "INPUT",
          `${profile.id} needs a required verification check`,
        );
      const config = this.app.buildConfig(profile, ticket, graphContext);
      const cut = config.workflow.phases.findIndex((p) =>
        ["approval", "publish"].includes(p.provider ?? ""),
      );
      if (cut >= 0) {
        if (
          config.workflow.phases
            .slice(cut)
            .some((p) => !["approval", "publish"].includes(p.provider ?? ""))
        )
          throw new HarnessError(
            "INPUT",
            "Multi-repo workflows require publication/approval phases to be a terminal suffix",
          );
        config.workflow.phases = config.workflow.phases.slice(0, cut);
      }
      if (
        !["intake", "verify", "review"].every((provider) =>
          config.workflow.phases.some((p) => p.provider === provider),
        )
      )
        throw new HarnessError(
          "INPUT",
          "Each child workflow needs intake, verify and review providers",
        );
      config.workflow = compileWorkflow({
        ...config.workflow,
        id: config.workflow.id + "-candidate",
      });
      config.source.revision = git(profile.path, [
        "rev-parse",
        "--verify",
        `${profile.base}^{commit}`,
      ]);
      return { repositoryId: profile.id, config };
    });
    const phases: Phase[] = members.map((m, i) => ({
      id: `repository-${String.fromCharCode(97 + i)}`,
      executor: "deterministic",
      dependsOn: i
        ? [`repository-${String.fromCharCode(96 + i)}`]
        : ["workspace-intake"],
      provider: `child:${m.repositoryId}`,
      output: `candidate:${m.repositoryId}`,
      timeoutMs: 1800000,
      maxAttempts: 3,
    }));
    phases.unshift({
      id: "workspace-intake",
      executor: "deterministic",
      provider: "workspace-intake",
      dependsOn: [],
      output: "shared-ticket",
      timeoutMs: 600000,
      maxAttempts: 3,
    });
    for (const [id, executor] of [
      ["cross-verify", "deterministic"],
      ["linked-approval", "human"],
      ["linked-publish", "deterministic"],
    ] as const)
      phases.push({
        id,
        executor,
        provider: id,
        dependsOn: [phases.at(-1)!.id],
        output: id,
        timeoutMs: 1800000,
        maxAttempts: 3,
      });
    const config: RunConfig = {
      coordination: { workspace: structuredClone(group), members },
      ticket: members[0].config.ticket,
      source: { repository: group.id, revision: "", files: [], omitted: [] },
      skills: {},
      workflow: compileWorkflow({
        id: "multi-repository",
        version: "1",
        phases,
      }),
      runtime: {
        name: "deterministic-coordinator",
        version: "1",
        executableHash: "none",
        configHash: hash(JSON.stringify(group)),
        isolation: "workstation",
      },
    };
    const run = this.app.store.create(config);
    if (enqueue) this.app.data.enqueue(run.id);
    return this.app.detail(run.id);
  }
  config(id: string) {
    return JSON.parse(this.app.store.get(id).config_json) as RunConfig;
  }
  repositoryNames(id: string) {
    return this.config(id).coordination!.members.map((m) => m.repositoryId);
  }
  candidates(id: string) {
    const config = this.config(id),
      children = this.app.data.children(id);
    return config.coordination!.members.map((member) => {
      const child = children.find(
        (c) => c.config.product.repositoryId === member.repositoryId,
      );
      if (!child || this.app.store.get(child.id).status !== "COMPLETED")
        throw new HarnessError(
          "POLICY",
          "All repository candidates must complete before cross verification/publication",
        );
      this.app.store.verify(child.id);
      const subject = this.app.publicationSubject(
        child.id,
        child.config.product.profile,
      );
      return { runId: child.id, ...subject };
    });
  }
  subject(id: string) {
    try {
      return this.currentSubject(id);
    } catch (error) {
      this.app.store.transaction(() => {
        const result = this.app.store.db
          .prepare(
            "UPDATE approvals SET status='INVALIDATED' WHERE run_id=? AND status IN ('PENDING','APPROVED')",
          )
          .run(id);
        if (result.changes)
          this.app.store.append(id, "APPROVAL_INVALIDATED", {
            reason: "Revision set or cross-repository evidence changed",
          });
      });
      throw error;
    }
  }
  currentSubject(id: string) {
    const candidates = this.candidates(id);
    const verification = this.app.data.data(id, "cross-verification");
    const selected = this.app.store.selected(id, "cross-verify");
    if (
      hash(JSON.stringify(sanitize(verification))) !==
      hash(this.app.store.read(selected))
    )
      throw new HarnessError(
        "POLICY",
        "Cross verification does not match selected evidence",
      );
    if (
      !verification ||
      verification.candidatesHash !== hash(JSON.stringify(candidates)) ||
      !verification.results.some((r: any) => r.required) ||
      verification.results.some((r: any) => r.required && !r.passed)
    )
      throw new HarnessError(
        "POLICY",
        "Current revision set lacks passing cross-repository verification",
      );
    return {
      type: "linked-publication",
      workspace: this.config(id).coordination!.workspace.id,
      candidates,
      crossVerificationHash: hash(JSON.stringify(verification)),
      effects: ["publish-approved-repository-set"],
      atomic: false,
    };
  }
  authorizeChild(parentId: string, childId: string) {
    const subject = this.subject(parentId);
    if (!subject.candidates.some((c) => c.runId === childId))
      throw new HarnessError("POLICY", "Child is not a member of approved run");
    // Parent ownership prevents a separate CLI/request publishing children while reconciliation is running.
    this.app.store.assertOwner(parentId);
    const approval = this.app.data
      .approvals()
      .find(
        (a) =>
          a.run_id === parentId &&
          a.status === "APPROVED" &&
          a.subject_hash === hash(JSON.stringify(subject)),
      );
    if (!approval)
      throw new HarnessError(
        "POLICY",
        "Current repository set has no matching linked approval",
      );
    return approval;
  }
  async execute(
    id: string,
    signal?: AbortSignal,
  ): Promise<ReturnType<Application["detail"]>> {
    const config = this.config(id),
      group = config.coordination!;
    const runtime: AgentRuntime = {
      describe: async () => config.runtime,
      cancel: async () => {},
      async *run() {
        throw new Error("Parent coordinator never invokes an agent");
      },
    };
    const handlers: Record<string, PhaseHandler> = {};
    handlers["workspace-intake"] = async ({ attempt, signal }) => {
      const profiles = group.members.map(
        (m) => m.config.product!.profile as RepositoryProfile,
      );
      const profile = profiles.find((p) => p.ticketSource) ?? profiles[0];
      const ticket = await new TicketIntake(this.app).resolve(
        id,
        config.ticket,
        profile,
        attempt,
        signal,
      );
      this.app.data.set(id, "ticket", ticket);
      return ticket;
    };
    for (const member of group.members)
      handlers[`child:${member.repositoryId}`] = async ({ signal }) => {
        let child = this.app.data
          .children(id)
          .find((c) => c.config.product.repositoryId === member.repositoryId);
        if (!child) {
          const childConfig = {
            ...member.config,
            parentRunId: id,
            ticket: this.app.data.data<Ticket>(id, "ticket")!,
          };
          const created = this.app.store.create(childConfig);
          child = { id: created.id, config: childConfig };
          this.app.store.append(id, "CHILD_RUN_CREATED", {
            runId: child.id,
            repository: member.repositoryId,
          });
        }
        this.app.data.set(child.id, "base", member.config.source.revision);
        const comments = this.app.data.data(id, "ticket-comments");
        if (comments) this.app.data.set(child.id, "ticket-comments", comments);
        const scope = group.workspace.repositories.find(
          (r) => r.repositoryId === member.repositoryId,
        )!;
        this.app.data.set(child.id, "coordination-context", {
          parentRunId: id,
          scope,
          repositories: group.members.map((m) => ({
            repositoryId: m.repositoryId,
            base: m.config.source.revision,
          })),
          dependencies: this.app.data
            .children(id)
            .filter((c) =>
              scope.dependsOn.includes(c.config.product.repositoryId),
            )
            .map((c) => ({
              repository: c.config.product.repositoryId,
              runId: c.id,
              candidate: this.app.data.data(c.id, "candidate"),
            })),
          instruction:
            "Only modify this repository's worktree. Dependency candidates are context, not writable workspaces.",
        });
        const result = await this.app.execute(child.id, signal, id);
        this.app.store.append(id, "CHILD_RUN_UPDATED", {
          runId: child.id,
          status: result.status,
        });
        if (result.status !== "COMPLETED")
          throw new HarnessError(
            ["FAILED", "CANCELLED"].includes(result.status)
              ? "INPUT"
              : "INFRASTRUCTURE",
            `Repository ${member.repositoryId}: ${result.status}; ${result.error ?? "Inspect child run"}`,
          );
        return {
          runId: child.id,
          subject: this.app.publicationSubject(
            child.id,
            member.config.product!.profile as RepositoryProfile,
          ),
        };
      };
    handlers["cross-verify"] = async ({ attempt, signal }) => {
      const candidates = this.candidates(id),
        candidatesHash = hash(JSON.stringify(candidates));
      const paths = Object.fromEntries(
        candidates.map((c) => [
          c.repository,
          this.app.data.data<Candidate>(c.runId, "candidate")!.workspace,
        ]),
      );
      const results: any[] = [];
      for (const check of group.workspace.checks) {
        if (signal.aborted)
          throw new HarnessError("CANCELLED", "Cross verification cancelled");
        const invocationId = randomUUID();
        const args = check.args.map((arg) =>
          arg.replace(/\{workspace:([^}]+)\}/g, (_, repo) => paths[repo]),
        );
        this.app.recordInvocation(id, invocationId);
        const runner = new ProcessRuntime(
          this.app.store.root,
          { ...config.runtime, name: "cross-repository-command" },
          () => ({
            command: check.executable,
            args,
            cwd: paths[check.cwdRepository],
            env: {
              PATH: process.env.PATH!,
              HOME: process.env.HOME!,
              CI: "true",
            },
          }),
        );
        runner.rawOutput = true;
        let observed: any;
        try {
          for await (const event of runner.run(
            { invocationId, prompt: "", timeoutMs: check.timeoutMs },
            signal,
          )) {
            this.app.store.emit(
              id,
              `CROSS_CHECK_${event.type}`,
              { checkId: check.id, payload: event.payload },
              attempt,
            );
            if (event.type === "COMPLETED")
              observed = JSON.parse(event.payload.text);
          }
        } finally {
          for (const evidence of runner.evidence(invocationId))
            this.app.store.put(id, attempt.id, evidence.role, evidence.value);
        }
        const result = {
          id: check.id,
          required: check.required,
          passed: observed?.code === 0 && !observed?.signal && !signal.aborted,
          invocationId,
          command: { ...check, args },
          observed,
        };
        results.push(result);
        this.app.data.set(id, "cross-verification", {
          candidatesHash,
          results,
        });
        if (hash(JSON.stringify(this.candidates(id))) !== candidatesHash)
          throw new HarnessError(
            "POLICY",
            "Cross checks changed the revision set",
          );
      }
      const verification = { candidatesHash, results };
      this.app.store.put(
        id,
        attempt.id,
        "cross-verification-report",
        verification,
      );
      if (results.some((r) => r.required && !r.passed))
        throw new HarnessError(
          "VALIDATION",
          "Required cross-repository checks failed",
        );
      return verification;
    };
    handlers["linked-approval"] = async () => {
      const proposal = this.app.data.proposal(id, this.subject(id));
      if (proposal.status === "REJECTED")
        throw new HarnessError("POLICY", "Linked publication rejected");
      if (proposal.status !== "APPROVED") throw new Waiting();
      return { id: proposal.id, subjectHash: proposal.subject_hash };
    };
    handlers["linked-publish"] = async ({ signal }) => {
      const publications = [];
      for (const candidate of this.subject(id).candidates) {
        if (signal.aborted)
          throw new HarnessError(
            "CANCELLED",
            "Linked publication cancelled; inspect partial results",
          );
        const childConfig = this.config(candidate.runId);
        const result = await this.app.publish(
          candidate.runId,
          childConfig.product!.profile as RepositoryProfile,
        );
        publications.push({
          repository: candidate.repository,
          runId: candidate.runId,
          result,
        });
        this.app.data.set(id, "publication", {
          atomic: false,
          complete: false,
          publications,
        });
        this.app.store.append(id, "LINKED_PR_RECORDED", publications.at(-1));
      }
      const result = { atomic: false, complete: true, publications };
      this.app.data.set(id, "publication", result);
      return result;
    };
    const result = await new Coordinator(
      this.app.store,
      runtime,
      hash,
      handlers,
      async () => {
        await this.app.reconcile(id);
        for (const child of this.app.data.children(id))
          await this.app.reconcile(child.id);
      },
    ).resume(id, signal);
    this.app.store.db
      .prepare("UPDATE jobs SET status=? WHERE run_id=?")
      .run(result.status, id);
    return this.app.detail(id);
  }
}
