# Agentic Engineering Harness Architecture

Status: proposed

This document defines the initial architecture for a local engineering control
plane that uses Gemini CLI as its first agent runtime. It deliberately does not
define a general-purpose agent framework.

The governing rule is:

> Thin harness, strong models, deterministic controls, excellent observability,
> measurable quality.

## 1. Decisions and boundaries

### 1.1 Architectural style

Build a modular monolith distributed as one local `eng` tool, with an optional
local server process when the web UI arrives.

The application has four kinds of components:

1. Pure domain code owns states, invariants, and transition decisions.
2. Application services orchestrate use cases through ports.
3. Adapters talk to Gemini CLI, SQLite, Git, the filesystem, Jira, Confluence,
   Stash, and build tools.
4. The CLI and HTTP server are composition roots. They do not contain business
   rules.

There is one SQLite database and one artifact root per installation. Large or
streaming data is stored as files; SQLite stores metadata, hashes, references,
and queryable summaries.

```text
CLI                 Local React UI
 |                       |
 +---- application services / query services ----+
                          |
                  workflow coordinator
                 /     |      |       \
           policies  context  evals   graph
                 \     |      |       /
                    domain + ports
              /        |          |          \
          SQLite   artifact FS   Gemini CLI   Git/internal systems
```

This is not a set of independently deployed services. Package boundaries exist
to protect dependency direction and testability, not to create network hops.

### 1.2 Source of truth

- Normalized SQLite records are the current-state source of truth.
- The event log is an append-only audit and observability stream, written in the
  same database transaction as the state change.
- The event log is not the only source from which state must be rebuilt. Full
  event sourcing adds recovery and migration complexity without helping the
  first milestones.
- Artifact content is immutable and content-addressed on disk. A database row
  binds it to a run, phase, attempt, role, and provenance.
- Git is authoritative for repository revision and worktree state. On recovery,
  the harness reconciles Git and OS state with its database records.
- External systems are authoritative for their own objects. Publication records
  cache their identifiers and idempotency state.

### 1.3 Trust model

Workflow definitions, installed skill files, policy configuration, command
providers, and adapter configuration are trusted executable configuration. Jira,
Confluence, repository content, Git history, model output, comments, and tool
output are untrusted data.

Untrusted data can influence a model prompt and produce a proposal. It cannot:

- grant a capability;
- select an unapproved executable or workflow;
- weaken a validator or approval rule;
- alter pass thresholds;
- access credentials directly;
- authorize or perform publication;
- turn a failed command into a passing result.

### 1.4 Versioning and reproducibility

A run captures immutable snapshots or hashes for:

- the compiled workflow definition;
- policy configuration;
- ticket content;
- repository and base commit;
- Gemini CLI executable path and version;
- agent runtime configuration;
- every skill and prompt file;
- context bundle manifests;
- evaluator and scorer versions.

The database stores both a human-readable version and a content hash. A mutable
path such as `skills/plan/SKILL.md` is never sufficient provenance by itself.

## 2. Proposed architecture

### 2.1 Workflow compiler

Workflow YAML is parsed, schema-validated, and compiled into an immutable
`CompiledWorkflow` before a run begins. Compilation verifies:

- unique phase IDs;
- known executor and provider names;
- acyclic dependencies;
- reachable phases;
- input/output artifact references;
- valid retry and timeout values;
- valid conditions from a small typed predicate vocabulary;
- policy compatibility;
- a stable canonical representation and content hash.

Do not allow JavaScript, shell expressions, template evaluation, or arbitrary
model-generated conditions in workflow files. Initial predicates should be
named operations such as `artifact_exists`, `phase_passed`, `validation_passed`,
and `run_input_equals`.

### 2.2 Workflow coordinator

The coordinator is a persisted state machine. It:

1. Acquires a run lease.
2. Reconciles interrupted work.
3. Calculates phase readiness from dependencies and conditions.
4. Starts at most one mutating executor for a workspace.
5. Records an attempt before launching work.
6. Streams normalized events and raw output to durable storage.
7. Runs independent validators after executor completion.
8. Classifies failure and applies the declared retry rule.
9. Advances, waits, blocks, fails, or completes the run.
10. Releases the lease.

The scheduler should initially be deliberately boring: one active phase per run
and one foreground coordinator process. DAG parallelism can be added after there
is a measured need. Dependency semantics should support it, but V1 does not need
to execute parallel phases.

### 2.3 Executors

An executor performs work but cannot mark its own phase as passed.

- `agent`: invokes an `AgentRuntime`, persists its event stream and outputs, then
  submits artifacts to validators.
- `deterministic`: invokes a registered provider with structured arguments. A
  provider may run a child process using an argument array; workflow content
  does not become an interpolated shell command.
- `human`: creates a revision-bound approval request and enters `WAITING`.

Executors return observations. The coordinator and validators decide outcomes.

### 2.4 Validators and policy

Validators are deterministic functions or trusted command providers. They
produce `ValidationResult` records with evidence artifact references. Examples
include artifact schema validation, process exit status, Git diff scope, current
revision, test report parsing, and approval validity.

Policy answers whether an action is allowed. Validation answers whether an
observed result meets a criterion. Keep them separate:

- policy: "PR publication requires approval bound to revision X";
- validation: "the candidate revision is X and the approval is still valid".

### 2.5 Context engine

The context engine builds a new, phase-specific `ContextBundle` for each agent
attempt. A bundle is a manifest of immutable context items, ordered into named
sections, with a token or byte budget and an explanation for every inclusion.

The first implementation should use deterministic selection rules, not vector
search:

- explicitly required artifacts;
- ticket snapshot and acceptance criteria;
- phase-declared repository paths;
- current diff or failures when applicable;
- graph query results when graph support arrives;
- capped recent history only when a phase explicitly requests it.

Ranking becomes a replaceable strategy later. Raw previous conversations are
not inherited automatically.

### 2.6 Artifact and evidence store

Use a content-addressed layout under `.harness/artifacts`, for example:

```text
.harness/
  harness.sqlite
  artifacts/sha256/ab/cd/<full-hash>
  runs/ENG-2026-000184/manifest.json
  workspaces/ENG-2026-000184/       # milestone 2
```

Writes use a temporary file, flush, hash verification, and atomic rename. The
database row is inserted only after the content exists. Human-friendly run
manifests contain references, not duplicate mutable copies.

Evidence is an artifact with a typed relationship to a validation or eval. For
example, a `test-report` plus process metadata can support `tests_exit_zero`.
Model-authored claims are reports, not evidence of command success.

### 2.7 Observability delivery

All interfaces consume the same stored event stream:

- CLI tails it and formats concise terminal output;
- the future HTTP API exposes historical pagination and Server-Sent Events;
- the UI combines current-state queries with the stream;
- metrics are projections over state and events.

SSE is sufficient for one local workstation. WebSockets, a broker, and a
separate telemetry service are unnecessary.

## 3. Domain model

### 3.1 Aggregates

`EngineeringRun` is the main consistency boundary. It owns run status,
workflow identity, inputs, current progress, cancellation state, and phase
instances. Only application services holding the run lease may advance it.

`WorkflowDefinition` is immutable once referenced by a run. A compiled snapshot
is stored even if its source file later changes.

`PhaseRun` is one logical phase within one run. It owns state and a sequence of
`PhaseAttempt` records. A retry creates an attempt; it does not overwrite prior
failure evidence.

`ApprovalRequest` is a proposal for one action and one immutable candidate. For
publication its subject includes repository, target branch, source branch,
candidate commit, diff hash, and policy hash.

`GraphSnapshot` is an immutable successfully built index for a repository at a
commit. A partially built snapshot is never served as current.

`EvaluationRun` applies a versioned configuration to a fixed set of cases and
variants. It references ordinary engineering runs rather than implementing a
second workflow engine.

### 3.2 Value objects

Use opaque IDs for internal references and a separate display ID:

```ts
type RunId = string & { readonly __brand: "RunId" };
type ArtifactId = string & { readonly __brand: "ArtifactId" };
type Revision = string & { readonly __brand: "Revision" };
type Sha256 = string & { readonly __brand: "Sha256" };

interface RunIdentity {
  id: RunId;                 // UUID or ULID, never reused
  displayId: string;         // ENG-2026-000184
}
```

The display counter is convenient, but it is not the database primary key.

### 3.3 State machines

Run states:

```text
CREATED -> RUNNING -> WAITING -> RUNNING -> COMPLETED
                    \-> BLOCKED
          \-> FAILED
          \-> CANCELLED
```

`WAITING` means a known resumable wait, normally approval. `BLOCKED` means no
automatic transition is possible and operator intervention is required.

Phase states use the requested vocabulary:

```text
PENDING -> READY -> RUNNING -> PASSED
                         |\-> FAILED
                         |\-> BLOCKED
                         |\-> WAITING -> READY
PENDING/READY -----------> SKIPPED
non-terminal ------------> CANCELLED
```

`FAILED` is terminal for the phase only after retry policy is exhausted. A
failed attempt may return the phase to `READY` for another attempt.

### 3.4 Failure classification

Keep a compact, actionable taxonomy:

```ts
type FailureClass =
  | "USER_INPUT"       // invalid ticket/repository/request
  | "POLICY"           // prohibited capability or invalid approval
  | "VALIDATION"       // executor finished, independent checks failed
  | "AGENT"            // agent protocol/error/non-completion
  | "TOOL"             // build, test, Git, or integration failure
  | "TIMEOUT"
  | "CANCELLED"
  | "INFRASTRUCTURE"   // DB, disk, process launch, unavailable dependency
  | "INTERNAL";        // harness invariant or bug
```

Retryability is a separate computed property. For example, validation failures
may be retryable for an implementation phase but not for intake.

## 4. Major TypeScript interfaces

These are boundary contracts, not a requirement to create one package per
interface.

```ts
type ExecutorType = "agent" | "deterministic" | "human";
type PhaseStatus =
  | "PENDING" | "READY" | "RUNNING" | "WAITING"
  | "PASSED" | "FAILED" | "BLOCKED" | "SKIPPED" | "CANCELLED";

interface CompiledWorkflow {
  id: string;
  version: string;
  contentHash: Sha256;
  phases: ReadonlyMap<string, CompiledPhase>;
  canonicalDefinition: unknown;
}

interface CompiledPhase {
  id: string;
  executor: ExecutorSpec;
  dependsOn: readonly string[];
  condition?: PredicateSpec;
  inputs: readonly ArtifactRequirement[];
  outputs: readonly ArtifactDeclaration[];
  validators: readonly ValidatorSpec[];
  retry: RetryPolicy;
  timeoutMs: number;
  capabilities: readonly Capability[];
}

type ExecutorSpec =
  | { type: "agent"; runtime: string; skillRef: string; mode: "read" | "write" }
  | { type: "deterministic"; provider: string; args: unknown }
  | { type: "human"; approvalType: string };

interface WorkflowCoordinator {
  start(command: StartRunCommand): Promise<EngineeringRun>;
  advance(runId: RunId): Promise<AdvanceResult>;
  resume(runId: RunId): Promise<AdvanceResult>;
  requestCancellation(runId: RunId): Promise<void>;
}
```

Agent runtime isolation:

```ts
interface AgentRuntime {
  readonly name: string;
  describe(): Promise<AgentRuntimeDescriptor>;
  run(request: AgentRequest, signal: AbortSignal): AsyncIterable<AgentEvent>;
  cancel(invocationId: string): Promise<void>;
}

interface AgentRequest {
  invocationId: string;
  runId: RunId;
  phaseId: string;
  attempt: number;
  workspace?: WorkspaceHandle;
  context: ContextBundle;
  skill: VersionedDocument;
  outputContract: JsonSchemaDocument;
  capabilities: readonly Capability[];
  deadline: string;
}

type AgentEvent =
  | { type: "SESSION_STARTED"; sessionId: string; runtimeData?: unknown }
  | { type: "MESSAGE"; role: "agent"; content: string }
  | { type: "TOOL_REQUESTED"; toolCallId: string; name: string; input: unknown }
  | { type: "TOOL_RESULT"; toolCallId: string; outcome: "ok" | "error"; output: unknown }
  | { type: "ERROR"; code: string; message: string; retryable?: boolean }
  | { type: "COMPLETED"; result: AgentCompletion };
```

`GeminiCliRuntime` launches an executable directly with `spawn(executable,
args, options)`, passes dynamic prompt/context through stdin or files, captures
stdout and stderr separately, and never constructs a shell command. A parser
inside this adapter translates the installed Gemini CLI's supported structured
stream into the normalized events. Unknown records are preserved as raw
artifacts rather than silently discarded.

Context contracts:

```ts
interface ContextItem {
  id: string;
  source: "jira" | "confluence" | "repo" | "git" | "graph" | "phase";
  sourceUri?: string;
  contentArtifactId: ArtifactId;
  contentHash: Sha256;
  retrievedAt: string;
  trust: "untrusted" | "trusted-instruction";
  selectedBecause: string;
  metadata: Readonly<Record<string, unknown>>;
}

interface ContextBundle {
  id: string;
  strategy: string;
  strategyVersion: string;
  manifestHash: Sha256;
  items: readonly ContextItem[];
  estimatedTokens?: number;
  byteCount: number;
}

interface ContextBuilder {
  build(request: ContextRequest): Promise<ContextBundle>;
}
```

Execution, validation, and policy ports:

```ts
interface DeterministicExecutor {
  execute(request: DeterministicRequest, signal: AbortSignal): Promise<ExecutionObservation>;
}

interface PhaseValidator {
  readonly type: string;
  validate(request: ValidationRequest): Promise<ValidationResult>;
}

interface PolicyEngine {
  authorize(request: AuthorizationRequest): Promise<PolicyDecision>;
}

interface ValidationResult {
  validator: string;
  version: string;
  status: "PASS" | "FAIL" | "ERROR";
  summary: string;
  evidenceArtifactIds: readonly ArtifactId[];
  details: unknown;
}
```

Persistence and artifacts:

```ts
interface UnitOfWork {
  transaction<T>(work: (stores: Stores) => Promise<T>): Promise<T>;
}

interface RunStore {
  get(id: RunId): Promise<EngineeringRun | undefined>;
  insert(run: EngineeringRun): Promise<void>;
  save(run: EngineeringRun, expectedVersion: number): Promise<void>;
}

interface EventStore {
  append(event: NewHarnessEvent): Promise<HarnessEvent>;
  list(runId: RunId, afterSequence?: number): Promise<readonly HarnessEvent[]>;
}

interface ArtifactStore {
  put(input: ArtifactInput): Promise<StoredArtifact>;
  open(id: ArtifactId): Promise<NodeJS.ReadableStream>;
  verify(id: ArtifactId): Promise<boolean>;
}
```

Workspace and external action ports arrive in milestones 2 and 6:

```ts
interface WorkspaceManager {
  create(spec: WorkspaceSpec): Promise<WorkspaceHandle>;
  inspect(handle: WorkspaceHandle): Promise<WorkspaceObservation>;
  acquireWriter(handle: WorkspaceHandle, owner: string): Promise<WorkspaceLease>;
  releaseWriter(lease: WorkspaceLease): Promise<void>;
}

interface PublicationAdapter {
  findByIdempotencyKey(key: string): Promise<PublicationResult | undefined>;
  createPullRequest(request: ApprovedPublication): Promise<PublicationResult>;
}
```

Graph and evaluation ports are defined in sections 10 and 11.

## 5. Event model

### 5.1 Event envelope

```ts
interface HarnessEvent<T = unknown> {
  id: string;              // ULID, useful for cross-run ordering
  runId: RunId;
  sequence: number;        // contiguous within a run
  phaseId?: string;
  attemptId?: string;
  type: HarnessEventType;
  occurredAt: string;
  recordedAt: string;
  actor: {
    type: "harness" | "agent" | "human" | "integration";
    id: string;
  };
  schemaVersion: number;
  correlationId?: string;
  causationId?: string;
  payload: T;
  payloadArtifactId?: ArtifactId;
}
```

Do not store secrets, full environment variables, or arbitrarily large output in
the event payload. Store redacted summaries plus artifact references.

### 5.2 Initial event types

```ts
type HarnessEventType =
  | "RUN_CREATED"
  | "RUN_STARTED"
  | "RUN_WAITING"
  | "RUN_BLOCKED"
  | "RUN_CANCELLATION_REQUESTED"
  | "RUN_CANCELLED"
  | "RUN_COMPLETED"
  | "RUN_FAILED"
  | "RUN_RECOVERY_STARTED"
  | "RUN_RECOVERED"
  | "PHASE_READY"
  | "PHASE_STARTED"
  | "PHASE_WAITING"
  | "PHASE_RETRY_SCHEDULED"
  | "PHASE_PASSED"
  | "PHASE_FAILED"
  | "PHASE_BLOCKED"
  | "PHASE_SKIPPED"
  | "PHASE_CANCELLED"
  | "AGENT_SESSION_STARTED"
  | "AGENT_MESSAGE"
  | "TOOL_REQUESTED"
  | "TOOL_RESULT"
  | "AGENT_COMPLETED"
  | "ARTIFACT_CREATED"
  | "VALIDATION_COMPLETED"
  | "APPROVAL_REQUESTED"
  | "APPROVAL_GRANTED"
  | "APPROVAL_REJECTED"
  | "APPROVAL_INVALIDATED"
  | "EXTERNAL_ACTION_STARTED"
  | "EXTERNAL_ACTION_RECONCILED"
  | "EXTERNAL_ACTION_COMPLETED"
  | "EVAL_COMPLETED"
  | "ERROR";
```

State changes and their events are committed atomically. High-volume process
output may be buffered to an artifact while emitting periodic summary events;
one database row per stdout chunk is neither useful nor cheap.

## 6. SQLite schema

SQLite runs in WAL mode with foreign keys enabled and a busy timeout. All times
are UTC ISO-8601 text. JSON columns are text validated at repository boundaries.
Migrations are forward-only in normal use and tested both up and down during
development.

The schema below is logical DDL; exact index names and migration syntax can be
settled during implementation.

### 6.1 Core schema: first vertical slice

```sql
CREATE TABLE schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE installation_counters (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

CREATE TABLE workflow_versions (
  workflow_id TEXT NOT NULL,
  version TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workflow_id, version),
  UNIQUE (content_hash)
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  display_id TEXT NOT NULL UNIQUE,
  workflow_id TEXT NOT NULL,
  workflow_version TEXT NOT NULL,
  status TEXT NOT NULL,
  ticket_key TEXT,
  repository_uri TEXT NOT NULL,
  base_revision TEXT NOT NULL,
  working_branch TEXT,
  workspace_path TEXT,
  active_phase_id TEXT,
  config_json TEXT NOT NULL,
  policy_hash TEXT NOT NULL,
  next_event_sequence INTEGER NOT NULL DEFAULT 1,
  row_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  started_at TEXT,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  cancellation_requested_at TEXT,
  failure_class TEXT,
  failure_code TEXT,
  failure_summary TEXT,
  FOREIGN KEY (workflow_id, workflow_version)
    REFERENCES workflow_versions(workflow_id, version)
);

CREATE TABLE phase_runs (
  run_id TEXT NOT NULL,
  phase_id TEXT NOT NULL,
  status TEXT NOT NULL,
  executor_type TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  current_attempt INTEGER NOT NULL DEFAULT 0,
  ready_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  failure_class TEXT,
  failure_code TEXT,
  failure_summary TEXT,
  row_version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (run_id, phase_id),
  FOREIGN KEY (run_id) REFERENCES runs(id)
);

CREATE TABLE phase_attempts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  phase_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  status TEXT NOT NULL,
  executor_type TEXT NOT NULL,
  started_at TEXT NOT NULL,
  heartbeat_at TEXT,
  completed_at TEXT,
  deadline_at TEXT,
  owner_instance_id TEXT,
  process_id INTEGER,
  runtime_session_id TEXT,
  exit_code INTEGER,
  context_bundle_id TEXT,
  raw_output_artifact_id TEXT,
  failure_class TEXT,
  failure_code TEXT,
  failure_summary TEXT,
  recovery_json TEXT,
  UNIQUE (run_id, phase_id, attempt_number),
  FOREIGN KEY (run_id, phase_id) REFERENCES phase_runs(run_id, phase_id)
);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  phase_id TEXT,
  attempt_id TEXT,
  kind TEXT NOT NULL,
  media_type TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  schema_name TEXT,
  schema_version INTEGER,
  provenance_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES runs(id),
  FOREIGN KEY (attempt_id) REFERENCES phase_attempts(id)
);

CREATE TABLE artifact_bindings (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  phase_id TEXT NOT NULL,
  attempt_id TEXT,
  artifact_id TEXT NOT NULL,
  direction TEXT NOT NULL,       -- INPUT | OUTPUT | EVIDENCE
  role TEXT NOT NULL,
  ordinal INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id, phase_id) REFERENCES phase_runs(run_id, phase_id),
  FOREIGN KEY (artifact_id) REFERENCES artifacts(id)
);

CREATE TABLE context_bundles (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  phase_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  strategy TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  byte_count INTEGER NOT NULL,
  estimated_tokens INTEGER,
  created_at TEXT NOT NULL,
  FOREIGN KEY (attempt_id) REFERENCES phase_attempts(id)
);

CREATE TABLE context_items (
  id TEXT PRIMARY KEY,
  bundle_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  source TEXT NOT NULL,
  source_uri TEXT,
  content_artifact_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  retrieved_at TEXT NOT NULL,
  trust TEXT NOT NULL,
  selected_because TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  UNIQUE (bundle_id, ordinal),
  FOREIGN KEY (bundle_id) REFERENCES context_bundles(id),
  FOREIGN KEY (content_artifact_id) REFERENCES artifacts(id)
);

CREATE TABLE validations (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  phase_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  validator TEXT NOT NULL,
  validator_version TEXT NOT NULL,
  status TEXT NOT NULL,
  summary TEXT NOT NULL,
  details_json TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  FOREIGN KEY (attempt_id) REFERENCES phase_attempts(id)
);

CREATE TABLE validation_evidence (
  validation_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  PRIMARY KEY (validation_id, artifact_id),
  FOREIGN KEY (validation_id) REFERENCES validations(id),
  FOREIGN KEY (artifact_id) REFERENCES artifacts(id)
);

CREATE TABLE harness_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  phase_id TEXT,
  attempt_id TEXT,
  type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  correlation_id TEXT,
  causation_id TEXT,
  payload_json TEXT NOT NULL,
  payload_artifact_id TEXT,
  UNIQUE (run_id, sequence),
  FOREIGN KEY (run_id) REFERENCES runs(id)
);

CREATE TABLE run_leases (
  run_id TEXT PRIMARY KEY,
  owner_instance_id TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES runs(id)
);
```

Important indexes include events by `(run_id, sequence)`, runs by
`(status, updated_at)`, phase attempts by `(run_id, phase_id)`, artifacts by
`content_hash`, and stale attempts by `(status, heartbeat_at)`.

### 6.2 Milestone 2 and 6 operational tables

```sql
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE,
  repository_uri TEXT NOT NULL,
  base_revision TEXT NOT NULL,
  branch TEXT NOT NULL,
  path TEXT NOT NULL,
  state TEXT NOT NULL,
  observed_head TEXT,
  observed_diff_hash TEXT,
  created_at TEXT NOT NULL,
  last_reconciled_at TEXT,
  FOREIGN KEY (run_id) REFERENCES runs(id)
);

CREATE TABLE workspace_leases (
  workspace_id TEXT PRIMARY KEY,
  owner_attempt_id TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  phase_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  subject_json TEXT NOT NULL,
  subject_hash TEXT NOT NULL,
  policy_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT,
  decision_note TEXT,
  invalidated_at TEXT,
  invalidation_reason TEXT,
  FOREIGN KEY (run_id) REFERENCES runs(id)
);

CREATE TABLE external_actions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  phase_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  subject_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  external_id TEXT,
  external_url TEXT,
  request_artifact_id TEXT,
  response_artifact_id TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  last_reconciled_at TEXT,
  FOREIGN KEY (run_id) REFERENCES runs(id)
);
```

Approvals are invalidated whenever the recomputed subject hash changes. The PR
adapter checks `external_actions` and then queries Stash by an idempotency marker
before retrying an ambiguous request.

## 7. Repository and package structure

Avoid starting with the full package list from the brief. Too many packages
create ceremony before boundaries have earned it. Begin with:

```text
engineering-harness/
  apps/
    cli/
      src/
    server/                    # milestone 3
      src/
    web/                       # milestone 3
      src/
  packages/
    core/
      src/
        domain/
        application/
        ports/
        workflow/
        context/
        policy/
    persistence-sqlite/
      src/
      migrations/
    runtime-gemini-cli/
      src/
    artifacts-fs/
      src/
    git/                       # milestone 2
      src/
    graph/                     # milestone 4
      src/
    evals/                     # milestone 5
      src/
    integrations/              # split only when adapters grow
      src/jira/
      src/confluence/
      src/stash/
  workflows/
    pilot-v1.yaml
  skills/
    requirements/
    plan/
  evals/
    cases/
    fixtures/
    suites/
  docs/
    architecture.md
    adr/
  .harness/                    # ignored runtime data
  package.json
  tsconfig.base.json
```

Use npm workspaces initially unless the workstation's approved toolchain already
standardizes on another package manager. Pin Node and every dependency. Do not
assume a public registry; installation must work from the internal registry or a
checked-in approved dependency cache.

Within `core`, directories may later become packages if they need independent
release cadence or have a proven dependency boundary. In particular, `context`
and `policy` do not need separate packages on day one.

## 8. Dependency direction

```text
apps/cli -----------+
apps/server --------+--> core/application --> core/domain
                    |          |
                    |          +-----------> core/ports
                    |
                    +--> composition only
                           |     |      |
                      sqlite  gemini  artifact-fs
                         git  graph   evals/integrations
```

Rules:

- `core/domain` imports no adapters, Node child-process APIs, HTTP framework, or
  SQLite library.
- `core/application` depends on domain types and ports only.
- Adapter packages implement ports and may depend on `core` contracts.
- Adapters do not call each other. An application service coordinates them.
- `graph` and `evals` expose application-facing ports; they do not import CLI,
  server, or UI code.
- The web app imports generated/shared API types only, never persistence code.
- Composition roots construct concrete implementations and configuration.

If TypeScript project references or lint rules can enforce these edges, use
them. A diagram without enforcement tends to become historical fiction.

## 9. Lifecycle of one engineering run

1. `eng run JIRA-428 --repo payment-service` resolves a trusted workflow by ID,
   validates user input, compiles the workflow, and records its snapshot.
2. Intake resolves the repository and exact base commit, retrieves the ticket
   through a configured adapter, stores an immutable ticket artifact, and
   creates the run and all phase records in one transaction.
3. The coordinator acquires the run lease and emits `RUN_STARTED`.
4. It evaluates dependencies and conditions, moving eligible phases from
   `PENDING` to `READY` with events.
5. Before an attempt, it resolves input artifacts, builds a context bundle,
   records the attempt, and emits `PHASE_STARTED` in one transaction.
6. The executor runs. Agent and tool streams become normalized events; complete
   raw streams are artifacts. Heartbeats record liveness.
7. On executor completion, declared outputs are parsed and schema-validated.
   Trusted validators independently inspect artifacts, process status, Git, or
   other authoritative state.
8. The coordinator marks the phase `PASSED` only when all required validators
   pass. Otherwise it classifies the failure and either schedules another
   attempt or ends the phase.
9. For a human executor, the run enters `WAITING`. A later `eng approve` records
   the actor and decision against the subject hash, then makes the phase ready
   to finish.
10. For a publication executor, policy and approval are rechecked immediately
    before the idempotent external action.
11. When every terminal phase is passed or legitimately skipped, the run becomes
    `COMPLETED`. The run manifest summarizes artifacts, versions, evidence, and
    final revision.

`eng status` is a read-only projection from current-state tables. `eng logs`
reads events. Neither advances a workflow.

## 10. Failure and recovery model

### 10.1 Delivery semantics

Local computation is at-least-once. Database state changes are transactional,
but child processes and external systems cannot participate in the SQLite
transaction. Exactly-once behavior is obtained only where an operation supports
reconciliation plus idempotency.

Every attempt and consequential external action therefore has a stable ID before
it begins.

### 10.2 Heartbeats and leases

The coordinator owns a renewable run lease. A mutating attempt also owns the
workspace write lease. Leases include an instance ID and expiry; acquiring an
expired lease is allowed only through the recovery path. The database enforces
one writer.

Process IDs are hints, not identity. Recovery must also verify process start
metadata or an invocation marker so PID reuse cannot attach to an unrelated
process.

### 10.3 `eng resume`

Resume performs reconciliation before scheduling:

1. Acquire or recover the run lease.
2. Verify workflow, policy, skill, and artifact hashes are available.
3. Verify artifact files and mark missing/corrupt artifacts as infrastructure
   failure.
4. Inspect any `RUNNING` attempt: process liveness, runtime session metadata,
   deadline, and final output marker.
5. Inspect the Git worktree when present: path, branch, HEAD, dirty state, locks,
   and diff hash.
6. Inspect ambiguous external actions against the external system before any
   retry.
7. Record a recovery decision and evidence; never silently rewrite history.
8. Continue waiting, reattach where the adapter guarantees it is safe, or mark
   the old attempt `INTERRUPTED` and create a new attempt according to policy.

For Gemini CLI V1, do not promise session reattachment until the installed CLI
proves a reliable machine-readable resume contract. Preserve its session ID and
stream, then normally start a new attempt with a freshly constructed context
that includes prior output and observed workspace state.

### 10.4 Retry behavior

Retries are explicit per phase and failure class. Use bounded exponential delay
only for transient integration/infrastructure failures. Agent retries should
receive the validator failure and current verified state, not an unbounded
conversation transcript.

For future write phases, declare one of two workspace retry policies:

- `continue`: preserve the current diff and tell the next attempt what failed;
- `restore_checkpoint`: restore a harness-owned attempt checkpoint after first
  saving the failed diff as an artifact.

Never reset an unverified or non-isolated user workspace. Worktrees make this
policy enforceable.

### 10.5 Crash windows

- Artifact written, DB row absent: harmless orphan, collected later after a
  retention period.
- DB state and event: committed together, so they cannot disagree due to a
  process crash.
- Child process started, attempt row exists: recovered through invocation marker
  and liveness inspection.
- External request sent, response not recorded: reconcile by idempotency key or
  external marker; do not blindly send it again.
- Approval granted, revision changed: subject hash mismatch invalidates approval.

Add crash-injection tests at these boundaries. Recovery is a feature to test,
not an exception path to hope works.

## 11. Knowledge graph V1

### 11.1 Scope

Choose the language only after selecting the pilot repository. For TypeScript,
prefer the TypeScript compiler API because it provides project configuration and
symbol resolution. For other languages, use the language's compiler/indexer or
tree-sitter plus a conservative resolver.

V1 indexes only relationships that can carry explicit provenance and a stated
confidence:

- files and declared symbols;
- containment;
- imports and resolved dependencies;
- classes/interfaces and reliable extends/implements relationships;
- calls only where the adapter can resolve a target;
- test files and conservative `TESTS` relationships;
- source locations for every node and edge.

Do not use an LLM to create structural edges. Do not infer database reads/writes,
events, ownership, or Jira links until a deterministic adapter or explicit
historical record exists.

### 11.2 Interfaces

```ts
interface LanguageAdapter {
  readonly language: string;
  readonly version: string;
  discover(project: ProjectInput): Promise<readonly SourceUnit[]>;
  index(unit: SourceUnit, project: ProjectContext): Promise<FileIndex>;
}

interface FileIndex {
  file: IndexedFile;
  nodes: readonly GraphNodeInput[];
  edges: readonly GraphEdgeInput[];
  diagnostics: readonly IndexDiagnostic[];
}

interface CodeGraph {
  search(snapshotId: string, query: string): Promise<readonly GraphNode[]>;
  neighbors(nodeId: string, query?: NeighborQuery): Promise<GraphNeighborhood>;
  dependencies(nodeId: string): Promise<readonly GraphNode[]>;
  dependents(nodeId: string): Promise<readonly GraphNode[]>;
  callers(nodeId: string): Promise<readonly GraphNode[]>;
  callees(nodeId: string): Promise<readonly GraphNode[]>;
  testsFor(nodeId: string): Promise<readonly GraphNode[]>;
  impactAnalysis(snapshotId: string, files: readonly string[]): Promise<ImpactResult>;
}
```

`impactAnalysis` is graph reachability with explicit limits, edge filters, and
paths explaining each result. It is not a model opinion.

### 11.3 Graph schema

```sql
CREATE TABLE repositories (
  id TEXT PRIMARY KEY,
  canonical_uri TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE graph_snapshots (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  revision TEXT NOT NULL,
  adapter_versions_json TEXT NOT NULL,
  status TEXT NOT NULL,             -- BUILDING | READY | FAILED
  created_at TEXT NOT NULL,
  completed_at TEXT,
  diagnostics_artifact_id TEXT,
  UNIQUE (repository_id, revision, adapter_versions_json),
  FOREIGN KEY (repository_id) REFERENCES repositories(id)
);

CREATE TABLE graph_files (
  snapshot_id TEXT NOT NULL,
  path TEXT NOT NULL,
  language TEXT,
  content_hash TEXT NOT NULL,
  index_status TEXT NOT NULL,
  diagnostic_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (snapshot_id, path),
  FOREIGN KEY (snapshot_id) REFERENCES graph_snapshots(id)
);

CREATE TABLE graph_nodes (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  qualified_name TEXT,
  file_path TEXT,
  start_line INTEGER,
  start_column INTEGER,
  end_line INTEGER,
  end_column INTEGER,
  stable_key TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  UNIQUE (snapshot_id, stable_key),
  FOREIGN KEY (snapshot_id) REFERENCES graph_snapshots(id)
);

CREATE TABLE graph_edges (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  type TEXT NOT NULL,
  confidence REAL NOT NULL,
  file_path TEXT,
  start_line INTEGER,
  start_column INTEGER,
  provenance_json TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  UNIQUE (snapshot_id, source_id, target_id, type, file_path, start_line, start_column),
  FOREIGN KEY (snapshot_id) REFERENCES graph_snapshots(id),
  FOREIGN KEY (source_id) REFERENCES graph_nodes(id),
  FOREIGN KEY (target_id) REFERENCES graph_nodes(id)
);
```

Index node name, qualified name, stable key, edge source/type, and edge
target/type. SQLite FTS5 can support symbol search if available in the approved
SQLite build; a vector database is not needed.

### 11.4 Incremental indexing

Build a new snapshot in `BUILDING` state. Copy unchanged indexed records from the
previous compatible snapshot, reparse files whose content hash changed, remove
deleted files, and re-resolve edges for changed files plus direct importers.
Only atomically mark the snapshot `READY` after consistency checks pass.

This simple snapshot model duplicates some rows. Accept that cost first. More
complex temporal storage or content-addressed graph fragments should wait for
real repository-size data.

Git-history enrichment is a later layer with separate commit, change, ticket,
PR, and co-change tables. Do not overload structural edges with historical
facts in V1.

## 12. Eval framework V1

### 12.1 One runner, not a second harness

An eval case is an immutable run specification plus scorer configuration. The
eval framework invokes the same `StartRun` application service in an isolated
fixture repository and later scores its resulting artifacts and evidence.

```ts
interface EvalCase {
  id: string;
  version: string;
  repositoryFixture: FixtureRef;
  ticketArtifact: ArtifactRef;
  workflowId: string;
  expected: Readonly<Record<string, unknown>>;
  scorers: readonly ScorerSpec[];
}

interface EvalVariant {
  id: string;
  configuration: Readonly<Record<string, unknown>>;
  configurationHash: Sha256;
}

interface Scorer {
  readonly name: string;
  readonly version: string;
  score(input: ScoreInput): Promise<ScoreResult>;
}

interface ScoreResult {
  status: "PASS" | "FAIL" | "ERROR" | "NOT_APPLICABLE";
  value?: number;
  summary: string;
  evidence: readonly EvidenceRef[];
  details: unknown;
}

interface SemanticScorer extends Scorer {
  readonly runtime: string;
  readonly rubricHash: Sha256;
}
```

### 12.2 Initial scorers

Implement deterministic scorers first:

- workflow completion;
- artifact schema validity;
- expected relevant files found by analysis;
- required acceptance criteria extracted, using fixture IDs;
- build/test exit status when write workflows arrive;
- changed-file allow/deny scope;
- expected tests selected and run;
- attempt count and elapsed time.

Semantic requirement coverage comes after deterministic plumbing. It must score
each acceptance criterion independently, cite artifact or diff evidence, record
the evaluator runtime/rubric/context versions, and remain distinguishable from
objective pass gates.

### 12.3 Experiments and comparison

An experiment is a paired matrix of cases and variants. Each pair gets a fresh
fixture clone and run. Randomize execution order where environmental drift could
bias results, and record machine/tool versions.

Report per-case results before aggregates. For control versus treatment, show:

- paired outcome delta;
- build/test and requirement-coverage deltas;
- attempts, runtime, and context-size deltas;
- error and missing-result counts;
- semantic scorer disagreement or uncertainty.

Do not present a percentage without its denominator. Do not treat failed or
timed-out runs as missing data. Token usage is optional until Gemini exposes it
reliably.

Minimal persistence:

```sql
CREATE TABLE eval_suites (
  id TEXT NOT NULL,
  version TEXT NOT NULL,
  definition_hash TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  PRIMARY KEY (id, version)
);

CREATE TABLE eval_experiments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  suite_id TEXT NOT NULL,
  suite_version TEXT NOT NULL,
  status TEXT NOT NULL,
  config_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE eval_case_runs (
  id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  case_version TEXT NOT NULL,
  variant_id TEXT NOT NULL,
  variant_hash TEXT NOT NULL,
  engineering_run_id TEXT,
  status TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  UNIQUE (experiment_id, case_id, case_version, variant_id)
);

CREATE TABLE eval_results (
  id TEXT PRIMARY KEY,
  eval_case_run_id TEXT NOT NULL,
  scorer TEXT NOT NULL,
  scorer_version TEXT NOT NULL,
  status TEXT NOT NULL,
  value REAL,
  summary TEXT NOT NULL,
  details_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (eval_case_run_id, scorer, scorer_version)
);
```

## 13. UI architecture

The UI is a local React application served by the local harness server. It uses
HTTP queries for snapshots and SSE for live events.

```text
React UI -> typed REST API -> application/query services -> stores
       \-> SSE /api/runs/:id/events ----------------------^
```

Recommended screen order:

1. Run list with status, ticket, repository, active phase, age, and failure.
2. Run detail with phase timeline, current attempt, validations, events, and
   artifacts.
3. Phase detail with input bindings, context provenance, normalized agent/tool
   events, raw-output download, validators, and attempts.
4. Approval inbox with immutable candidate details and diff link.
5. Graph explorer after Graph V1 is reliable.
6. Eval comparison dashboard after the eval runner produces trustworthy data.

The first UI should be operational and dense, closer to a build console than a
marketing dashboard. Use tables, tabs, status marks, timestamps, and deep links.
Do not begin with a canvas graph library. A searchable node detail page with
incoming/outgoing edge tables proves correctness earlier; add visualization once
the data is trusted.

API notes:

- version endpoints under `/api/v1`;
- return view models, not database rows;
- cursor-paginate event and run lists;
- use SSE `Last-Event-ID` for reconnection;
- artifact content is streamed through an endpoint that checks path ownership;
- mutation endpoints call the same application services as CLI commands;
- approval commands require candidate/subject hash to prevent stale UI actions.

Do not share persistence types with the browser. A small generated OpenAPI client
or a deliberately shared transport-schema package is sufficient.

## 14. Security boundaries

### 14.1 Harness control boundary

The harness process owns policy, state transitions, trusted workflow selection,
validation, credentials, and publication. Gemini receives only the context,
workspace access, and tool capabilities declared for the current phase.

For the read-only first slice, invoke Gemini in its most restrictive supported
mode and provide no publication credentials. For write phases, filesystem scope
is the run worktree. The adapter must reject tool activity outside declared
capabilities when the Gemini protocol exposes requests; OS-level containment is
still preferable where the workstation supports it.

### 14.2 Credential boundary

- Adapters obtain credentials from the workstation's approved credential
  mechanisms at call time.
- Credentials are never placed in prompts, context artifacts, workflow YAML,
  events, or child-process arguments when stdin/environment alternatives exist.
- Give Jira/Confluence read adapters read-only identities where enforceable.
- Keep Stash publication credentials unavailable until the approved publication
  executor runs.
- Central redaction applies before logs or artifacts are persisted, with tests
  for known secret formats.

### 14.3 Process and command boundary

- No `shell: true` for agent, Git, build, or integration process launch.
- Executable paths and command providers come from trusted configuration.
- Arguments are arrays; dynamic large content goes through stdin or bounded
  files.
- Environment variables are allowlisted per provider.
- Timeouts terminate the process group and record the observation.
- Repository scripts are untrusted code. Running build/test therefore requires
  an explicit workflow capability and the workstation's normal sandboxing.

### 14.4 Filesystem and Git boundary

- Canonicalize and validate all paths against configured roots.
- Reject symlink escapes when reading artifacts or managing workspaces.
- Never run an agent with write access to the user's source checkout.
- Worktree branch names are harness-generated and validated.
- One database-enforced writer lease exists per worktree.
- Review operates on a captured commit/diff hash; publication uses that exact
  candidate or requests approval again.

### 14.5 Data and prompt-injection boundary

Every context item carries source and trust. Prompts clearly delimit untrusted
content and state that it is evidence, not instruction. This is defense in depth;
the real control is that the model lacks authority to change policy or execute
undeclared consequential actions.

Output schemas protect parsing, not truth. Independent validators and capability
checks remain mandatory even for valid JSON.

### 14.6 Audit boundary

SQLite is append-only by application convention for events, approvals, attempts,
and external actions. Hashes reveal artifact mutation. This is tamper-evident
enough for a local V1, not a tamper-proof compliance ledger. OS permissions,
backups, retention, export signing, and centralized audit shipping should be
added only when enterprise requirements demand them.

## 15. Simplify, delay, or change

The brief has the right product shape, but several pieces should be constrained:

| Brief idea | Initial decision | Reason |
| --- | --- | --- |
| Full 14-phase conversion | Start with three read-only phases | Learn the run contract before automating mutation and publication. |
| General DAG concurrency | Model dependencies, execute serially | Parallel coordination and multiple readers/writers add recovery complexity. |
| Separate workflow, state, policy, context, eval, graph services | Modules in one process | These are domain capabilities, not deployment units. |
| Event stream powers everything | Yes, but not event sourcing | Transactional state tables make queries and recovery simpler. |
| Arbitrary deterministic commands in YAML | Registered command providers | Prevent shell injection and make behavior versioned/testable. |
| Agent-declared structured success | Treat as an output artifact only | Validators determine pass/fail from authoritative observations. |
| Agent session resume | Best-effort adapter feature later | Durable harness resume does not require fragile conversational resume. |
| Rich context ranking immediately | Rule-based bundles with provenance | Easier to inspect, test, and compare. |
| Knowledge graph calls/semantics | Conservative resolved edges only | False structural claims undermine every downstream use. |
| Graph plus Git history in Graph V1 | Delay history enrichment | Structural indexing and historical analytics have different data lifecycles. |
| Interactive graph canvas first | Search and adjacency tables first | Data correctness matters more than visual novelty. |
| Semantic evals first | Deterministic scorers first | Establish evidence, fixtures, and repeatability before model judging. |
| Full experiment system in M5 | Paired variants over the same runner | Avoid building a scheduler/statistics platform. |
| Multiple runtime implementations | One port, Gemini adapter only | Extensibility is an interface property, not unused code. |
| Large package hierarchy | Six initial packages | Split modules only when coupling or ownership justifies it. |
| Generic integrations framework | Thin ports plus concrete adapters | Jira, Confluence, and Stash do not need a universal connector abstraction. |
| Immutable audit trail | Append-only, hashed local audit | Truly immutable storage is infrastructure and policy work beyond local SQLite. |
| Token metrics as a hard requirement | Record when reliably exposed | Do not estimate and present it as authoritative. |

Also defer distributed execution, background scheduling, multi-user RBAC, vector
retrieval, Neo4j, cross-run autonomous agent coordination, and automatic review
comment publication.

## 16. First vertical slice

Implement a read-only, crash-resumable workflow that proves the architecture
without touching application code in a target repository.

### 16.1 User-visible behavior

```bash
eng run JIRA-428 --repo /path/to/payment-service
eng status ENG-2026-000184
eng logs ENG-2026-000184
eng resume ENG-2026-000184
```

The pilot workflow is serial:

```text
intake (deterministic)
  -> requirements-analysis (Gemini, read-only)
  -> implementation-plan (Gemini, read-only)
```

`intake` captures the exact base commit, repository metadata, Gemini version,
skill hashes, workflow snapshot, and ticket snapshot. For the very first fixture,
support a local ticket JSON/Markdown source behind the same `TicketSource` port.
Add the real Jira adapter immediately after the durable flow works, using the
approved internal access mechanism discovered on the workstation.

`requirements-analysis` receives only the ticket snapshot plus a bounded,
explicitly selected repository context. It must emit a versioned JSON report and
a human-readable rendering.

`implementation-plan` receives the ticket snapshot, accepted requirements
artifact, and selected repository context. It emits a versioned plan artifact.

Required validators are artifact existence, content hash verification, JSON
schema validity, expected ticket identity, and repository/base-revision match.
Agent completion by itself is not a validator.

### 16.2 Included

- workspace/toolchain spike and pinned Node setup;
- minimal monorepo and dependency-boundary enforcement;
- workflow YAML schema and compiler;
- run/phase/attempt state machines;
- SQLite migrations and repositories;
- filesystem artifact store;
- transactional events and CLI event formatting;
- Gemini CLI descriptor, direct process launch, streaming normalization, timeout,
  cancellation plumbing, and raw-output capture;
- rule-based context bundles with provenance;
- `run`, `status`, `logs`, and `resume` application services and CLI commands;
- stale-lease and interrupted-attempt recovery;
- unit tests for every legal/illegal transition;
- integration tests using a fake agent runtime;
- one opt-in smoke test against installed Gemini CLI;
- crash-injection integration tests at attempt start, artifact creation, and
  phase completion boundaries.

### 16.3 Explicitly excluded

- Git worktrees and repository mutation;
- build/test commands;
- retries intended to repair code;
- web server and UI;
- knowledge graph indexing;
- semantic evaluation;
- Confluence retrieval;
- approvals, Stash writes, PR creation, or review publication;
- additional model runtimes.

### 16.4 Completion criteria

The slice is complete when:

1. A fixture run produces immutable ticket, requirements, plan, context, raw
   agent stream, runtime descriptor, validation, and run-manifest artifacts.
2. Killing the harness at each tested crash boundary and running `eng resume`
   reaches the same valid terminal state without duplicate phase attempts unless
   the recovery record explains why a retry was required.
3. `eng status` and `eng logs` agree with stored state and events.
4. Corrupting or removing an artifact prevents a false pass and yields a clear,
   recoverable infrastructure failure.
5. A fake model claim such as `testsPassed: true` has no effect on phase or run
   status.
6. All process launches avoid shell interpolation, and persisted logs pass secret
   redaction tests.

This slice establishes the hardest contract: the harness, not the agent, owns
truth and progress. Milestone 2 can then add isolated worktrees and deterministic
build/test execution without changing that contract.

## 17. Decisions needed before implementation

Only a few environmental choices should block the slice:

- exact installed Node.js and Gemini CLI versions and Gemini's structured-output
  and permission-mode capabilities;
- how Jira is currently accessed from the workstation;
- the pilot repository's primary language and build system;
- the approved internal package registry and available SQLite driver;
- the filesystem location and retention expectations for `.harness` data.

Everything else can proceed behind the ports above. In particular, selection of
a graph visualization library, Postgres, other model runtimes, and publication
details should not influence the first implementation.
