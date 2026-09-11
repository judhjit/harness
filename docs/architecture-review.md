# Agentic Engineering Harness: proposed architecture review

Status: proposal for discussion; no implementation authorized by this document.

This review accompanies [the existing architecture](architecture.md), which
already covers the requested architecture, domain, contracts, events, DDL,
packages, lifecycle, recovery, graph, evals, UI, security, and first slice. The
existing working-tree draft is preserved. Where they differ, the recommendations
below are the proposed corrections. Neither document describes implemented code.

## 1. Architecture and scope

Build a local modular monolith with three entry points over the same application
services: foreground CLI execution, CLI queries, and eventually HTTP/React.
Gemini CLI remains the only agent runtime. No external SaaS, runtime downloads,
broker, background scheduler, or additional model runtime is required.

```text
CLI commands                 React UI
     |                          |
     |                     local HTTP + SSE
     +-------------+------------+
                   |
          application services
       run coordinator / query services
                   |
          domain rules + ports
                   |
     SQLite / files / Gemini / Git / internal APIs
```

The coordinator owns phase outcomes. Agent output is a proposal or observation;
it cannot become authoritative verification evidence merely by matching a schema.

Merge workflow execution and the state machine into one coordinator. Keep policy,
context, and validation as small modules in core. Graph and evals are first-class
domain capabilities, introduced in later slices; they do not need independent
services. Validation and eval scoring share evidence types and deterministic
check implementations, but have different consumers: workflow gates versus
quality measurement.

Use a dependency DAG as the definition format, with serial execution initially.
Use `dependsOn`, not both `dependsOn` and `next`. Repairs are bounded attempts,
not arbitrary graph cycles. Conditions are trusted typed predicates. Dependency
rules explicitly distinguish success from a permitted skip; skipping a prerequisite
must not silently satisfy its dependent phase.

## 2. Domain model and invariants

| Entity | Responsibility |
| --- | --- |
| WorkflowVersion | Immutable compiled phases, artifact contracts, predicates, retry rules, provider references and hash |
| EngineeringRun | Immutable identity and configuration snapshot; aggregate status and cancellation intent |
| PhaseRun | One logical phase, dependencies, selected outputs, status |
| PhaseAttempt | One execution, immutable input binding, deadline, owner generation, outcome |
| ContextBundle | Ordered content manifest, source revisions, selection reasons, budgets and exclusions |
| Artifact | Immutable content blob plus media type, producer and provenance |
| Candidate | Exact source snapshot against which evidence and approval apply |
| ExecutionEvidence | Harness-observed command, environment identity, candidate, exit/signal and output hashes |
| ValidationResult | Versioned gate applied to evidence; PASS, FAIL or ERROR |
| Approval | Human decision for a specific action, candidate, target and policy |
| ExternalAction | Persisted intent, request identity, remote outcome and reconciliation state |
| GraphSnapshot | Repository/configuration identity, extraction results and completeness diagnostics |
| EvalCaseRun | One case × variant × repetition, linked to an ordinary engineering run |

Run states: `CREATED`, `RUNNING`, `WAITING`, `BLOCKED`, `COMPLETED`, `FAILED`,
`CANCELLED`. Phase states use the brief's vocabulary. Attempts additionally need
`PREPARING`, `RUNNING`, `SUCCEEDED`, `FAILED`, `INTERRUPTED`, `CANCELLED`.
An interrupted attempt is never relabeled successful without durable evidence.

`BLOCKED` means unresolved conditions require intervention; `FAILED` means the
configured execution budget ended. `resume` reconciles nonterminal work; it does
not reopen a failed run or silently reset its retry budget. A later explicit
retry operation must preserve history and record the new authorization/budget.

Only selected outputs of passing attempts satisfy downstream inputs. A schema-valid
plan is an available proposal, not a human-approved plan. Add a human phase only
where policy actually requires plan approval.

## 3. Major TypeScript contracts

These complement the existing draft's interfaces. Names represent domain
boundaries, not a requirement for one package or class per interface.

```ts
type Digest = string;
type CandidateId = string;
type ArtifactId = string;

interface Candidate {
  id: CandidateId;
  repositoryId: string;
  baseCommit: string;
  headCommit: string;
  sourceManifestHash: Digest;
  // Includes tracked changes and allowed untracked source inputs.
  sourceArtifactId: ArtifactId;
}

interface ExecutionEvidence {
  id: string;
  runId: string;
  attemptId: string;
  candidateId: CandidateId;
  producer: "harness-command-runner";
  providerId: string;
  providerVersion: string;
  invocationId: string;
  commandManifestArtifactId: ArtifactId;
  environmentManifestHash: Digest;
  startedAt: string;
  endedAt: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdoutArtifactId: ArtifactId;
  stderrArtifactId: ArtifactId;
  reportArtifactIds: readonly ArtifactId[];
}

interface RuntimeDescriptor {
  name: "gemini-cli";
  version: string;
  executableIdentityHash: Digest;
  structuredEvents: boolean;
  resumableSession: boolean;
  // Observation and authorization are separate capabilities.
  toolAuthorization: "enforceable" | "unavailable";
  containmentProfileId?: string;
}

interface AgentRuntime {
  describe(): Promise<RuntimeDescriptor>;
  run(request: AgentRequest, signal: AbortSignal): AsyncIterable<AgentEvent>;
  cancel(invocationId: string): Promise<void>;
}

interface WriterOwnership {
  resourceId: string;
  ownerInstanceId: string;
  generation: number;
  hostBootId: string;
  processIdentity: string;
}

interface EvidenceGate {
  evaluate(input: {
    candidate: Candidate;
    evidence: readonly ExecutionEvidence[];
    policyHash: Digest;
  }): Promise<{
    status: "PASS" | "FAIL" | "ERROR";
    reason: string;
    evidenceIds: readonly string[];
  }>;
}

interface GraphQuery {
  snapshotId: string;
  symbolKey: string;
  relationship: "neighbors" | "callers" | "callees" |
    "dependencies" | "dependents" | "tests";
  maxDepth: number;
  maxNodes: number;
}

interface Scorer {
  id: string;
  versionHash: Digest;
  kind: "deterministic" | "semantic";
  score(input: ScoringInput): Promise<ScoreResult>;
}
```

`AgentRequest`, `AgentEvent`, context contracts and persistence ports remain as
proposed in the original draft. Stream events do not prove process success: the
adapter must reconcile the final protocol record with process exit, truncation,
timeout and output validation. A reported tool request is not assumed to be an
interceptable authorization request.

Context should also record source commit/snapshot, truncation, omitted items and
selection configuration. File reads observed during execution extend the context
audit, separately from the initial bundle. If the runtime cannot expose all reads,
display that completeness limitation; do not claim to know every input it saw.

## 4. Event model

Keep the existing event envelope: event ID, run ID, per-run sequence, phase and
attempt IDs, type, schema version, occurred/recorded timestamps, actor,
correlation/causation IDs and bounded payload/artifact reference.

Define a typed payload map so event type determines payload shape. Validate
persisted envelopes and payloads. Separate `AGENT_COMPLETED` from `PHASE_PASSED`:
only the latter represents the coordinator's verified decision.

Add `ATTEMPT_INTERRUPTED`, `PROCESS_EXITED`, `EVIDENCE_CAPTURED`,
`WORKSPACE_RECONCILED`, `CONTEXT_BUILT`, and `EXTERNAL_ACTION_AMBIGUOUS`.
Events describing model/tool observations identify their source and never acquire
the authority of harness-issued evidence.

Persist transitions, selected outputs, validation summaries and corresponding
events in one short transaction. Never hold a transaction open while running an
agent, test, HTTP request or file transfer. SSE replays from persisted sequence
numbers; clients deduplicate and resynchronize if history is unavailable.

## 5. SQLite schema and storage corrections

The original draft contains the proposed core, graph, approval and eval DDL.
Treat it as a logical schema, not an implementation-ready migration. Apply these
constraints when creating the migrations:

- Add CHECK constraints for state vocabularies, executor types, nonnegative sizes,
  attempt numbers and valid numeric score ranges where specified by a scorer.
- Use composite foreign keys to prevent cross-run phase, attempt, evidence and
  artifact bindings. Add the missing event/artifact/context/eval foreign keys.
- Require graph edge endpoints to belong to the edge's snapshot, through composite
  foreign keys to `(snapshot_id, id)` on nodes.
- Give every graph edge a deterministic non-null `edge_key`; uniqueness over
  nullable source-location columns does not reliably deduplicate edges.
- Graph snapshot identity includes source manifest, parser version, resolver
  configuration, project configuration and dependency resolution inputs. Revision
  alone is insufficient.
- Separate global content blobs from run-owned artifact bindings. Graph diagnostics,
  workflow definitions and eval fixtures also need artifacts without a run owner.
- Make eval case identity include `repetition`; persist case, fixture, variant and
  scorer hashes, not only mutable names. Add all experiment/suite/run references.
- Add attempt retry deadlines and owner generations. Keep process identity and
  host boot identity in durable execution metadata; PID alone is insufficient.

Illustrative additions, referencing the base schema:

```sql
CREATE TABLE artifact_blobs (
  content_hash TEXT PRIMARY KEY,
  relative_path TEXT NOT NULL UNIQUE,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  created_at TEXT NOT NULL
);

CREATE TABLE candidates (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  base_commit TEXT NOT NULL,
  head_commit TEXT NOT NULL,
  source_manifest_hash TEXT NOT NULL,
  source_artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  created_at TEXT NOT NULL,
  UNIQUE (run_id, id)
);

CREATE TABLE command_executions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  provider_version TEXT NOT NULL,
  manifest_artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  environment_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN
    ('PREPARED', 'RUNNING', 'COMPLETED', 'INTERRUPTED')),
  exit_code INTEGER,
  exit_signal TEXT,
  timed_out INTEGER NOT NULL DEFAULT 0 CHECK (timed_out IN (0, 1)),
  started_at TEXT,
  ended_at TEXT,
  FOREIGN KEY (run_id, candidate_id) REFERENCES candidates(run_id, id),
  FOREIGN KEY (run_id, attempt_id) REFERENCES phase_attempts(run_id, id)
);
-- phase_attempts requires UNIQUE (run_id, id) for the composite reference.
-- Evidence bindings link stdout, stderr and parsed reports to this execution.
```

Create these tables only when their slice needs them. The first slice can keep
context items inside an immutable manifest and query them through application
services; dedicated context-item tables can wait for cross-run queries.

Use SQLite on local durable storage with foreign keys, WAL, a busy timeout and
an explicit durability setting. Test backup/restore including blobs; copying only
the database file while it is active is not a backup strategy. Use forward
migrations with restore-based rollback, rather than requiring down-migrations
that destroy run evidence. Keep SQL in the persistence adapter; avoid a generic
database abstraction that merely disguises SQL. Postgres portability comes from
application ports and database-independent domain rules.

## 6. Repository structure

Start smaller than either a subsystem-per-package layout or a full plugin system:

```text
apps/cli
packages/core/src/{domain,application,ports,workflow,context,policy}
packages/adapters/src/{sqlite,artifacts,gemini,git,integrations}
workflows/
skills/
tests/{fixtures,recovery}/
docs/

# Add as the corresponding slices arrive:
apps/server
apps/web
packages/graph/src/{model,indexing,languages,queries}
packages/evals/src/{runner,scorers,comparison}
evals/{cases,fixtures,suites}
```

Split adapters into packages when dependency weight or ownership warrants it.
One package per concrete adapter on day one is optional ceremony. Keep trusted
workflow/skill installation outside writable target workspaces.

## 7. Dependency direction

Domain imports no infrastructure. Application imports domain and ports. Adapters
implement ports and import their contracts. CLI/server wire implementations;
React imports transport schemas only. Graph/eval persistence uses the SQLite
adapter through ports, avoiding a graph-to-SQLite-to-core-to-graph cycle.

The eval runner calls the same run application service. Production run execution
does not depend on the experiment runner. Gate/scorer evidence contracts belong
in core, so sharing checks does not create that reverse dependency.

## 8. Lifecycle of an engineering run

1. Validate trusted configuration and allocate the immutable run ID before ticket
   retrieval, so intake failures are visible. Persist the requested ticket/repo;
   base commit and ticket snapshot may remain unresolved until intake succeeds.
2. Acquire ownership; intake captures the ticket, exact repository identity,
   workflow, policy, skills, runtime descriptor and execution configuration.
3. Select an eligible phase and persist a PREPARING attempt before building its
   context. Build and persist the manifest, bind inputs, then launch work.
4. Capture execution observations, sanitized output and process lifecycle.
5. Validate outputs independently. Commit selected outputs and the phase outcome
   with events; otherwise persist a failure and bounded retry decision.
6. In write slices, capture a candidate and verify it with no concurrent writer.
   Review receives that same candidate and evidence.
7. When publication arrives, propose the exact action and candidate; wait for an
   explicit approval, then recheck the subject and persist external-action intent.
8. Complete only when all required gates pass and all required effects have known
   outcomes. An approval request or unknown remote result is not completion.

The original schema's non-null `base_revision` must therefore become nullable
until intake succeeds, with an application invariant before repository phases.

## 9. Failure and recovery model

A lease prevents cooperative coordinators from overlapping; it cannot stop an
orphan process from modifying files. Use owner generations to fence database
writes, and independently establish that the previous process group has stopped
before admitting a replacement workspace writer. Uncertain liveness means BLOCKED.
Never kill a PID without verifying its invocation/process identity.

Persist execution intent before spawn. Use an invocation-specific durable spool
and a small process-launch protocol to record process identity and exit outcome.
Test the gap between spawn and identity persistence explicitly. If the harness
cannot establish what ran or whether it finished, preserve evidence and classify
the attempt INTERRUPTED; do not fabricate an exit code from agent output.

| Recovery observation | Decision |
| --- | --- |
| Old owner demonstrably active | Refuse a second owner; expose current status |
| Process gone, complete trusted evidence exists | Revalidate before finishing the phase |
| Process gone, evidence incomplete | Mark interrupted; retry within persisted budget |
| Workspace differs from last observation | Save the diff and provenance; reconcile before execution |
| Worktree writer liveness uncertain | Block until resolved; do not start another writer |
| Required artifact missing/corrupt | Invalidate dependent readiness; restore or recompute safely |
| External request outcome unknown | Reconcile remotely; block if absence cannot be established |
| Approval subject changed | Invalidate and request approval for the new subject |

Cancellation is an intent, followed by process termination/reconciliation, followed
by CANCELLED. A late remote success is recorded even if cancellation was requested.
No automatic retry of a build with unknown external effects is justified merely
because the executor is called deterministic. Providers declare whether replay is
safe, reconcilable or requires intervention.

Do not promise exactly-once remote effects. Persist action intent and a stable
marker, serialize dispatch, and query the remote system after ambiguous failures.
If the installed Stash API cannot uniquely reconcile an action, automatic replay
must stop. Reuse a deterministic comment identity for each reviewed candidate and
finding; comment publication needs the same treatment as PR creation.

## 10. Knowledge graph V1

Select one language with the pilot repository. Extract files, symbols, containment,
imports, resolved dependencies, and calls only where resolution is reliable.
Use language compiler APIs where feasible; parser choice follows the pilot rather
than assuming TypeScript is also the target repository language.

Each structural fact carries source location, snapshot, adapter version and a
resolution category such as `resolved`, `syntactic` or `heuristic`. Avoid invented
numeric confidence values for deterministic parser output. Record unresolved
references and diagnostics rather than silently dropping them.

Every query takes a snapshot, bounded depth/size and edge filters. Return paths,
completeness diagnostics and truncation markers. Empty callers/tests results mean
none found within indexed coverage, not proof that none exist.

Test imports establish dependency edges; they do not automatically prove behavioral
test coverage. `testsFor` returns candidate tests with association provenance.
Runtime coverage can add stronger evidence in a later slice. Define edge direction
once: Test TESTS Symbol, Symbol CHANGED_BY Commit; inverse UI labels are derived.

Incremental parsing caches by content/configuration hash. Reuse unchanged syntax,
but invalidate semantic resolution transitively where signatures, exports, aliases,
project configuration or dependencies change. Direct-importer invalidation alone
is insufficient. Fall back to project-wide resolution when correctness cannot be
established; incremental correctness takes precedence over speed.

Publish complete, immutable snapshots atomically. Remap all snapshot-local node
and edge IDs when copying records. Symbol keys are stable within a snapshot;
cross-revision identity after renames/overloads is not guaranteed. Delay historical
co-change, inferred ownership and ticket-to-execution-path analytics.

## 11. Eval framework V1

Cases pin fixture source, ticket, workflow, expected behavior, independent tests
and scorer versions. Run each case/variant/repetition in a fresh isolated workspace
through the ordinary coordinator. Compare graph context off/on as one paired
configuration change, not a separate orchestration implementation.

Run held-out test/scoring inputs outside agent-writable paths and keep reference
patches out of agent context. Reuse immutable public fixture inputs where sensible,
but separate runtime session/history and generated work between variants. Record
warm/cold dependency-cache conditions and reject uncontrolled fixture mutation.

Publish per-case results and denominators before aggregate percentages. Record
timeouts, harness errors, invalid scores and missing outputs explicitly. Separate
engineering success from harness reliability; show both end-to-end success and
conditional agent outcomes so infrastructure failures are neither hidden nor
misattributed. A reference patch is not an exact-match scoring target when multiple
implementations satisfy the task.

Semantic scoring uses a versioned rubric through the Gemini adapter, per-criterion
judgments, cited evidence and an explicit uncertainty/invalid-result state. It is
not a replacement for deterministic tests. A model's stated confidence is not a
calibrated probability. Review precision requires labeled findings; recall against
human review is an observed reference-set measure, not complete defect recall.

Store repetition IDs and report paired results across repeated runs when measuring
model changes. Capture runtime and resolved model identity/configuration when
exposed; CLI version alone does not identify the model. Offline means no public
retrieval or SaaS dependency; live-agent evals still require the already-approved
Gemini endpoint. Fully disconnected regression tests use a fake runtime.

## 12. UI architecture

Local React, typed REST queries and SSE over one event store. Start with Runs and
run detail: phases, attempts, context, artifacts, evidence and failure/recovery
decisions. Add Graph and Evals when real data exists. Tickets and Repositories can
initially be filters/detail panels; defer Experiments as a separate navigation item
until a comparison table stops being sufficient.

Use the same application services for CLI/HTTP mutations. The server owns an
execution worker when it eventually launches runs; an HTTP request is not the
lifetime of a run. Foreground CLI remains sufficient for the first slice.

Approve using an expected subject hash. Serve untrusted artifacts as escaped text
or attachments, never executable HTML. Bind locally, validate Host/Origin, use
local session authentication and CSRF protection for mutations, and disable broad
CORS. Localhost alone is not authorization for approval endpoints.

## 13. Security and evidence boundaries

A Git worktree isolates changes for workflow purposes, not hostile filesystem
access. Likewise, restricted prompts, an environment allowlist and a streamed tool
event do not establish an OS security boundary. The adapter must discover actual
installed runtime controls and fail closed when a required capability restriction
cannot be enforced. Do not promise runtime tool interception without testing it.

Use an approved OS sandbox or isolated execution identity where available. Protect
harness DB, artifact storage, policies, skills and credentials from the agent and
repository scripts. Account for Gemini's ambient config, repository instructions,
extensions, MCP integrations, Git hooks, credential helpers and network permissions.
Disable or constrain ambient executable configuration through supported controls;
if that is impossible, document the deployment as cooperative isolation and stop
short of claiming enforceable publication or credential separation.

The original draft's statement that the adapter can reject observed tool activity
is conditional on a genuine pre-execution authorization interface. A log stream
alone cannot prevent the action it reports.

Verification runs on a frozen candidate with protected runner configuration and
no agent writer. The harness records actual exit status, command identity and
source identity. A zero exit code proves that the configured command exited zero;
it does not prove useful tests ran or that the test suite is honest. Parse expected
reports/counts, detect missing results, and use protected golden tests where
independent behavioral guarantees are required. Any subsequent source change
invalidates the candidate's verification and approval eligibility.

Publication approval binds repository, source revision, diff/source manifest,
target branch, observed target revision when policy requires it, policy hash,
verification set and proposed publication payload. Recheck immediately before
dispatch under exclusive ownership; record target movement and reevaluate any
merge-sensitive gates. PR creation, branch push and review-comment publication
are separately identified effects with explicit authorization scope.

Event history is append-only by application policy. Attempts, approvals and
external-action rows are mutable current-state projections, with every transition
audited. Local hashes detect corruption relative to trusted metadata; an actor
able to rewrite the DB and blobs can rewrite both. Do not call this an immutable
or adversary-resistant ledger. Stronger audit guarantees need a separately
protected sink or signing key and belong to explicit enterprise requirements.

Sanitize logs before persistence. Label sanitized streams as such, cap size, and
record truncation; preserve exact unrestricted raw streams only when an approved
protected storage policy permits it. Redaction is best effort, not a guarantee
that arbitrary output contains no secret.

## 14. Recommended first vertical slice and decisions

Implement only after choosing the slice:

```text
intake (deterministic)
  -> requirements (Gemini)
  -> implementation-plan (Gemini)
```

Use a local ticket fixture through a `TicketSource` port, an exact repository
snapshot and bounded phase-specific context. Gemini produces structured artifacts
and readable reports. Call the result a planning workflow, not verified code or
an approved plan. Actual Jira retrieval follows through the approved mechanism.

Deliver `eng run`, `eng status`, `eng logs`, `eng resume` and minimal `eng cancel`;
SQLite state, artifact manifests, one event stream, schema/hash validation,
direct process launch, persisted retry budgets and crash reconciliation.

Resolve read-only enforcement during the initial workstation capability probe.
Do not expose a live developer checkout and assume a prompt protects it. Use a
controlled source snapshot with enforceable restrictions; if necessary, pull a
minimal workspace/sandbox step forward from milestone 2. No build/test execution,
UI, graph indexing, semantic scorer, publication or second runtime in this slice.

Acceptance: fixture execution produces inspectable requirements and plan;
process-kill/restart tests recover or block with an explicit reason; incomplete
evidence cannot produce PASS; simultaneous resumes cannot launch competing work;
cancellation stops owned work; shell interpolation is absent; source and control
storage restrictions are demonstrated. Include fake-runtime failure cases and
an opt-in smoke test against the enterprise-installed Gemini CLI.

Bring a tiny fixture/recovery regression harness into this first slice. Delay the
full eval product until milestone 5, but do not delay regression measurement until
then. Keep golden behavior tests separate from broad UI or experiment work.

Before implementation, establish the approved Node/dependency distribution,
Gemini executable/version/output/permission behavior, source-isolation mechanism
and pilot input. Pilot language and Jira access are needed for their adapters,
not reasons to design additional runtimes or a generic integration framework.

Recommendation: choose this planning-and-recovery slice first, followed by one
isolated implementation plus deterministic verification slice. Stop at this
architecture proposal until that choice is made.
