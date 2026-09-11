export type RunStatus =
  | "CREATED"
  | "RUNNING"
  | "WAITING"
  | "BLOCKED"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";
export type PhaseStatus =
  | "PENDING"
  | "READY"
  | "RUNNING"
  | "WAITING"
  | "SKIPPED"
  | "PASSED"
  | "FAILED"
  | "BLOCKED"
  | "CANCELLED";
export type FailureClass =
  | "INPUT"
  | "POLICY"
  | "VALIDATION"
  | "AGENT"
  | "TIMEOUT"
  | "INFRASTRUCTURE"
  | "CANCELLED";
export class HarnessError extends Error {
  category: FailureClass;
  constructor(category: FailureClass, message: string) {
    super(message);
    this.category = category;
  }
}
export interface Phase {
  id: string;
  executor: "deterministic" | "agent" | "human";
  dependsOn: string[];
  output: string;
  provider?: string;
  inputs?: string[];
  outputSchema?: Record<string, unknown>;
  access?: "read" | "write";
  when?: { phase: string; status: "PASSED" | "SKIPPED" };
  skill?: string;
  maxAttempts: number;
  timeoutMs: number;
}
export interface Workflow {
  id: string;
  version: string;
  phases: Phase[];
}
export interface Ticket {
  key: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
}
export interface SourceFile {
  path: string;
  content: string;
  hash: string;
}
export interface SourceSnapshot {
  repository: string;
  revision: string;
  files: SourceFile[];
  omitted: string[];
}
export interface RuntimeDescriptor {
  name: string;
  version: string;
  executableHash: string;
  configHash: string;
  isolation: string;
}
export interface RunConfig {
  parentRunId?: string;
  coordination?: {
    workspace: import("./product.ts").WorkspaceGroup;
    members: { repositoryId: string; config: RunConfig }[];
  };
  product?: {
    repositoryId: string;
    profile: unknown;
    ticketKey: string;
    graphContext: boolean;
  };
  ticket: Ticket;
  source: SourceSnapshot;
  workflow: Workflow;
  skills: Record<string, string>;
  runtime: RuntimeDescriptor;
}
export interface Run {
  id: string;
  display_id: string;
  status: RunStatus;
  config_json: string;
  config_hash: string;
  cancel_requested: number;
  owner: string | null;
  owner_pid: number | null;
  owner_identity: string | null;
  generation: number;
  updated_at: string;
  error: string | null;
}
export interface Attempt {
  id: string;
  run_id: string;
  phase_id: string;
  number: number;
  status: string;
  deadline: string;
}
export interface Artifact {
  id: string;
  run_id: string;
  attempt_id: string | null;
  role: string;
  hash: string;
  bytes: number;
}
export interface Event {
  run_id: string;
  sequence: number;
  type: string;
  phase_id: string | null;
  attempt_id: string | null;
  timestamp: string;
  payload_json: string;
}
export interface ContextItem {
  source: "ticket" | "repo" | "phase";
  uri: string;
  hash: string;
  selectedBecause: string;
  content: unknown;
}
export interface AgentRequest {
  invocationId: string;
  prompt: string;
  timeoutMs: number;
}
export type AgentEvent =
  | {
      type:
        | "SESSION_STARTED"
        | "MESSAGE"
        | "TOOL_REQUESTED"
        | "TOOL_RESULT"
        | "RAW"
        | "AGENT_ERROR";
      payload: unknown;
    }
  | {
      type: "COMPLETED";
      payload: { text: string; exitCode: number; usage?: unknown };
    };
export interface AgentRuntime {
  describe(): Promise<RuntimeDescriptor>;
  run(request: AgentRequest, signal: AbortSignal): AsyncIterable<AgentEvent>;
  cancel(invocationId: string): Promise<void>;
  evidence?(invocationId: string): { role: string; value: unknown }[];
}
export interface Store {
  create(config: RunConfig): Run;
  get(id: string): Run;
  phases(
    id: string,
  ): { phase_id: string; status: PhaseStatus; attempts: number }[];
  events(id: string, after?: number): Event[];
  artifacts(id: string): Artifact[];
  read(artifact: Artifact): string;
  put(
    runId: string,
    attemptId: string | null,
    role: string,
    value: unknown,
  ): Artifact;
  selected(runId: string, role: string): Artifact;
  acquire(runId: string): Promise<void>;
  release(runId: string): void;
  recover(runId: string): void;
  start(runId: string, phase: Phase): Attempt;
  pass(attempt: Attempt, artifact: Artifact): void;
  fail(attempt: Attempt, error: HarnessError, retry: boolean): void;
  state(runId: string, status: RunStatus, error?: string): void;
  emit(runId: string, type: string, payload?: unknown, attempt?: Attempt): void;
  requestCancel(runId: string): void;
  verify(runId: string): void;
  skip(runId: string, phase: Phase): void;
  wait(attempt: Attempt): void;
}
export class Waiting extends Error {}
export type PhaseHandler = (input: {
  run: Run;
  config: RunConfig;
  phase: Phase;
  attempt: Attempt;
  signal: AbortSignal;
}) => Promise<unknown>;

export function assertRunTransition(from: RunStatus, to: RunStatus): void {
  const transitions: Record<RunStatus, readonly RunStatus[]> = {
    CREATED: ["RUNNING", "BLOCKED", "CANCELLED"],
    RUNNING: [
      "RUNNING",
      "WAITING",
      "COMPLETED",
      "FAILED",
      "BLOCKED",
      "CANCELLED",
    ],
    WAITING: ["RUNNING", "BLOCKED", "CANCELLED"],
    BLOCKED: ["RUNNING", "BLOCKED", "FAILED", "CANCELLED"],
    COMPLETED: [],
    FAILED: [],
    CANCELLED: [],
  };
  if (!transitions[from].includes(to))
    throw new HarnessError(
      "INFRASTRUCTURE",
      `Illegal run transition: ${from} -> ${to}`,
    );
}

export function compileWorkflow(value: unknown): Workflow {
  const w = value as Workflow;
  if (
    !w ||
    typeof w.id !== "string" ||
    typeof w.version !== "string" ||
    !Array.isArray(w.phases) ||
    !w.phases.length ||
    w.phases.length > 50
  )
    throw new HarnessError("INPUT", "Workflow must contain 1–50 phases");
  const known = new Set<string>();
  for (const [index, p] of w.phases.entries()) {
    if (
      !p ||
      !/^[a-z][a-z-]{0,63}$/.test(p.id) ||
      known.has(p.id) ||
      !Array.isArray(p.dependsOn) ||
      p.dependsOn.some((d) => !known.has(d)) ||
      !Number.isInteger(p.maxAttempts) ||
      p.maxAttempts < 1 ||
      p.maxAttempts > 3 ||
      !Number.isInteger(p.timeoutMs) ||
      p.timeoutMs < 100 ||
      p.timeoutMs > 1_800_000 ||
      !["agent", "deterministic", "human"].includes(p.executor) ||
      typeof p.output !== "string" ||
      !p.output ||
      (p.when &&
        (!known.has(p.when.phase) ||
          !["PASSED", "SKIPPED"].includes(p.when.status)))
    )
      throw new HarnessError("INPUT", `Invalid or unsupported phase: ${p?.id}`);
    known.add(p.id);
  }
  return structuredClone(w);
}

export function validateTicket(value: unknown): Ticket {
  const t = value as Ticket;
  if (
    !t ||
    typeof t.key !== "string" ||
    !/^[A-Z][A-Z0-9]*-\d+$/.test(t.key) ||
    typeof t.title !== "string" ||
    !t.title.trim() ||
    typeof t.description !== "string" ||
    !Array.isArray(t.acceptanceCriteria) ||
    t.acceptanceCriteria.length === 0 ||
    t.acceptanceCriteria.some((c) => typeof c !== "string" || !c.trim())
  )
    throw new HarnessError(
      "INPUT",
      "Ticket requires key, title, description and nonempty acceptanceCriteria",
    );
  return structuredClone(t);
}

export function validateReport(
  text: string,
  phase: Phase,
  config: RunConfig,
): unknown {
  let value: any;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HarnessError(
      "VALIDATION",
      "Expected a JSON object without markdown fences",
    );
  }
  if (
    !value ||
    value.schemaVersion !== 1 ||
    value.ticketKey !== config.ticket.key ||
    value.baseRevision !== config.source.revision
  )
    throw new HarnessError(
      "VALIDATION",
      "Report schema, ticket or base revision mismatch",
    );
  const files = new Set(config.source.files.map((f) => f.path));
  if (phase.output === "requirements") {
    if (
      !Array.isArray(value.criteria) ||
      value.criteria.length !== config.ticket.acceptanceCriteria.length ||
      value.criteria.some(
        (c: any, i: number) =>
          c?.id !== `AC${i + 1}` ||
          typeof c.description !== "string" ||
          !c.description.trim(),
      ) ||
      !Array.isArray(value.relevantFiles) ||
      value.relevantFiles.some((f: unknown) => !files.has(f as string))
    )
      throw new HarnessError(
        "VALIDATION",
        "Requirements must cover every criterion ID and cite supplied files",
      );
  } else if (
    !Array.isArray(value.steps) ||
    !value.steps.length ||
    value.steps.some(
      (s: any) =>
        typeof s?.description !== "string" ||
        !s.description.trim() ||
        !Array.isArray(s.criterionIds) ||
        !s.criterionIds.length ||
        s.criterionIds.some(
          (id: unknown) =>
            !config.ticket.acceptanceCriteria.some(
              (_, i) => id === `AC${i + 1}`,
            ),
        ),
    ) ||
    !Array.isArray(value.verification) ||
    !value.verification.length ||
    value.verification.some(
      (v: unknown) => typeof v !== "string" || !v.trim(),
    ) ||
    config.ticket.acceptanceCriteria.some(
      (_, i) =>
        !value.steps.some((s: any) => s.criterionIds.includes(`AC${i + 1}`)),
    )
  ) {
    throw new HarnessError(
      "VALIDATION",
      "Plan requires steps covering every criterion and proposed verification",
    );
  }
  return value;
}
