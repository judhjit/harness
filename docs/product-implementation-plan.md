# Engineering Harness V1: implementation plan

Status: approved, implementation in progress.

Subsequent user decisions supersede the original Docker/graph sections below:

- Use the existing `gemini` command in the VS Code Server terminal. No Gemini
  Docker image is required; Docker is optional for check execution.
- The private pipeline now has nine phases; keep definitions/skills configurable
  for later import.
- Support Java, Node, Python and React repository/check profiles.
- Do not build a knowledge graph. Consume optional external providers (Graphify
  or alternatives) through command/snapshot adapters. See `graph-providers.md`.

## Product target

Deliver a single-operator engineering control plane running inside the existing
cloud workstation alongside VS Code Server. Preserve Gemini CLI as the reasoning
and coding runtime. Use the workstation's Docker access for isolated execution
where the capability check confirms it is suitable. Serve a local React UI through
VS Code port forwarding. No hosted control plane, public runtime downloads or
additional agent runtimes.

An engineer can register a repository, select a Jira ticket, start a run, inspect
its plan and activity, watch implementation/verification/repair, review evidence,
approve a specific candidate and publish a PR plus selected review findings.
They can recover interrupted runs, explore repository structure and compare
workflow/skill/context configurations on golden tasks.

Success means a usable workflow with coherent operation and measurable results,
not merely having a package for every subsystem in the original brief.

## Current baseline and necessary changes

The existing slice has SQLite state, immutable artifact blobs, a serial coordinator,
process supervision, a Gemini stream adapter, CLI queries/cancellation/resume,
explicit-file context and subprocess/recovery tests. Its last reported validation
was 22 passing tests and one skipped live Gemini test; this planning turn has not
rerun that suite.

It is intentionally a planning prototype:

- `compileWorkflow` accepts exactly three phases and two executor types.
- The runtime rejects tool use and receives source snippets through stdin.
- Context construction and output validation are coupled to the pilot workflow.
- Initial intake happens before run allocation.
- There is no implementation workspace, independent test runner, HTTP API or UI.
- Live Gemini and the Linux execution profile are not yet validated here.

Evolve these seams incrementally. Preserve existing runs through tested migrations;
do not replace the project with a generic agent framework. Before allowing mutable
workspaces, tighten phase transitions, evidence finalization before PASS, cancellation
races, subprocess cleanup and reconciliation of ambiguous outcomes.

## Deployment and Docker decision

```text
Browser
  │ VS Code forwarded port
  ▼
Local React UI + HTTP/SSE server
  │
Application services + one local execution worker
  ├── SQLite + artifact files
  ├── host Git/workspace manager
  ├── approved Jira / Confluence / Stash adapters
  └── Docker execution backend
        ├── Gemini CLI invocation container
        └── deterministic build/test container
```

Keep the control plane on the workstation initially. Docker is an execution
backend, separate from the `AgentRuntime` interface: Gemini semantics belong in
`GeminiCliRuntime`; container creation, process lifecycle and mounts belong in
`DockerExecutionBackend`. Deterministic command providers use that same backend.
The existing local process backend remains useful for tests and diagnostics.

The container profile will:

- Use an approved preloaded image pinned by immutable identity. Never auto-pull
  during a run. Support a separate documented import/build preparation step.
- Run without privilege escalation, with dropped capabilities and bounded CPU,
  memory, process count, disk/output growth and execution time where enforceable.
- Mount only the assigned source/worktree, temporary storage and explicitly
  approved runtime/authentication inputs. Keep harness state and artifacts outside.
- Never mount the Docker socket or expose Docker control credentials. Only the
  trusted harness can create, inspect, stop or remove its containers.
- Keep publication credentials out of Gemini and test environments. Authentication
  material needed by Gemini is a documented exposure to that process and potentially
  its tools; do not claim finer separation than the runtime actually supports.
- Preserve approved network routing, proxy and CA configuration. Verify Docker
  networking respects workstation restrictions; daemon access does not prove this.
  Test/build containers default to no network unless a provider needs approved access.
- Use deterministic names/labels tied to run and attempt IDs. Persist intent before
  creation, reconcile via inspection, and remove only exact harness-owned resources.
  No blanket Docker or Git cleanup commands.

Do not assume that a working host Gemini installation is automatically usable in
an image: validate Node/native dependencies, authentication and enterprise settings.
Support a configured runtime image or a verified read-only installation mount.
Do not copy the entire personal home directory into a container.

Docker is the preferred backend, subject to milestone A's validation. If workstation
policy prevents appropriate mounts, namespaces or network controls, use an approved
existing isolation mechanism through the backend port. Never silently run uncontained.

## Delivery sequence

Each milestone produces a demonstrable increment. Approval of the overall plan
authorizes implementation across these milestones without repeated design approvals.
Actual publication remains subject to the product's revision-bound approval flow.

| Milestone | Working outcome | Exit gate |
| --- | --- | --- |
| A. Workstation integration | Gemini runs through a verified Docker profile using approved authentication | Real smoke test, mounts/network/lifecycle checks and pinned environment manifest |
| B. Durable workflow foundation | Configurable agent, deterministic and human phases with recoverable state | Migration, transition, cancellation and crash tests pass |
| C. Engineering loop and context | Ticket → plan → implementation → verify → repair → review | A pilot task produces an isolated candidate and independent evidence |
| D. Local control-plane UI | Engineer starts and inspects runs through VS Code forwarding | Browser workflow works across refresh, disconnect and worker restart |
| E. Knowledge graph V1 | Correct structural queries enrich phase context | Incremental results agree with fresh indexing on fixtures |
| F. Evals and comparisons | Golden tasks compare skills/workflows/context strategies | Reproducible paired reports with per-task drill-down |
| G. Approved publication | Candidate → approval → branch/PR → selected comments | Stale approval and ambiguous remote-action tests pass |
| H. Product release hardening | Packaged, recoverable, documented workstation tool | Pilot end-to-end acceptance and release checklist pass |

### A. Workstation integration

Add `eng doctor` and a persisted installation profile covering Node, Gemini CLI,
Docker daemon/context, image availability, architecture, filesystem ownership,
approved endpoint/authentication configuration and local port-forwarding behavior.
Diagnostics redact credentials and perform no unrequested publication.

Introduce the execution-backend port and Docker implementation. Use direct argument
arrays; avoid interpolated shell commands. Identify stopped/running/unknown container
outcomes through Docker, not host PID assumptions. Test coordinator death, daemon
unavailability, workstation restart and interrupted container creation.

Capture real installed Gemini event fixtures with sensitive data removed. Handle
message deltas, final result, errors and process exit through a versioned adapter.
Record observed model identity/configuration when exposed; unknown stays unknown.
Build phase-specific investigation, implementation and review capability profiles.

Deliverables: workstation profile, Docker lifecycle adapter, Gemini compatibility
tests, offline image-preparation instructions and a real planning smoke test.
If workstation access is unavailable during development, complete contract tests
but explicitly leave the deployment gate unpassed.

### B. Durable workflow foundation

Replace positional pilot checks with versioned schemas and a compiled dependency
DAG. Execute serially initially. Register executor/providers, context strategies,
artifact schemas and validators in trusted configuration.

Support `agent`, `deterministic`, `human`; full phase states including WAITING and
SKIPPED; explicit dependency/skip semantics; bounded retries; timeouts; persisted
retry deadlines; cancellation; and human decisions. Use a small predicate vocabulary,
not embedded JavaScript or shell expressions.

Allocate a run before remote intake. Store workflow/policy/skill/provider versions,
input snapshots, candidate identities, context, validations and errors. Separate
attempt completion, evidence finalization and phase acceptance. Runtime output is
never an authoritative test result.

Add typed event envelopes, schema versions, bounded payloads, artifact references
and pagination. Refine persistence ports and forward migrations without creating a
generic ORM abstraction. Reconcile host processes, containers, Git and evidence
before resuming. Add an explicit audited retry/fork operation for failed runs;
`resume` never grants itself an unlimited new budget.

Deliverables: reusable coordinator, command/query services, migration tests,
human-phase service and crash-injection matrix. The existing planning workflow
continues working as a regression case.

### C. Engineering loop and enterprise context

Add repository profiles: local checkout/canonical remote, base branch, allowed
paths, language/build commands, runtime/test image and context policy. Git operations
and command execution are deterministic registered providers.

Create a host-managed worktree per run. Gemini can modify assigned source files,
but Git metadata and publication remain harness-controlled. Account for worktree
`.git` pointers and shared Git administration paths when constructing mounts.
Review and verification use a captured candidate; reject concurrent source writers.
Preserve failed diffs and checkpoints before any recovery that changes files.

Implement the loop:

```text
intake → repository investigation → requirements → plan
  → implementation → verification → bounded repair/reverification
  → review → requirement assessment → candidate ready
```

This is a reference flow, not a replacement invented for the existing 14 phases.
Map the actual skills/prompts into executor, input, output and gate contracts.
Preserve useful phases and merge orchestration-only phases into deterministic code.
Agents retain their native reasoning/coding loops inside a phase; the harness does
not orchestrate multiple agents chatting with each other.

Add Jira ticket/comments and bounded Confluence retrieval using the existing approved
access method. Keep fixture/file sources for offline tests. Support pagination,
attachment limits, internal URL allowlists, sanitized errors and retrieval provenance.
Do not let retrieved text select commands, capabilities or workflows.

Run configured build/test/lint/type checks independently. Capture command identity,
candidate source manifest, dependency/tool environment, exit/signal, reports and
test counts. A changed candidate invalidates prior evidence eligibility. Protect
verification configuration and check for empty or missing test reports.

Review emits structured findings with severity, source location, candidate and
evidence. Triage is recorded separately from raw findings. Blocking findings or
failed required checks prevent publication eligibility.

Deliverables: a real pilot implementation with evidence and a review report; no PR
publication yet. Introduce a few golden task fixtures now rather than postponing
all quality measurement until milestone F.

### D. Local API and React product

Add a local server and one persisted execution worker. Browser request lifetime
does not own the run; closing a tab cannot cancel execution. A small persisted
queue supports start requests, not a general-purpose scheduler. CLI and HTTP call
the same services; ownership prevents duplicate workers.

Primary screens:

- Runs: filtering, status, ticket, repository, active phase, duration and outcome.
- Run detail: phase timeline, current activity, attempts, context/provenance, plan,
  candidate diff, verification, review and recovery actions.
- Repositories: registration, command/runtime profiles and readiness diagnostics.
- Approvals: proposed action, exact candidate/evidence, diff and decision history.
- Graph and Evals: added as their services become available.
- Settings: runtime/integration health, trusted configuration and storage controls;
  secret values are never echoed back into the UI.

Tickets initially appear as run-creation search and run-linked details. Experiments
start within Evals. Add separate navigation only when there is a useful page behind it.

Provide typed REST endpoints and replayable SSE. Handle loading/empty/error states,
keyboard navigation, accessible status labels, long logs, connection loss, stale
actions and artifact downloads. Diff view should link findings and evidence to files.
Render untrusted content safely; bundle assets/fonts without public CDN dependencies.

Bind to loopback by default; document VS Code's private port forwarding and remote
browser URL. Configure allowed Host/Origin values for forwarding, local session
authentication and CSRF protection. Do not automatically expose the server on all
interfaces or treat possession of a forwarded URL as sufficient approval authority.

Deliverables: a complete browser journey from run creation to candidate inspection,
tested against both fixture execution and a pilot Gemini run.

### E. Knowledge graph V1

Implement one language adapter for the chosen pilot, rather than assuming that
the harness's TypeScript language matches enterprise repositories. Index files,
symbols, containment, imports, dependencies, reliable calls and test associations.
Persist graph snapshots in SQLite with extraction provenance and diagnostics.

Expose search, neighbors, callers, callees, dependencies, dependents, candidate
tests and bounded impact traversal. Return paths explaining impact and flag incomplete
resolution. Test imports are associations, not proof of behavioral coverage.

Cache unchanged syntax and invalidate semantic results when exports, dependencies,
configuration or resolution change. Compare incremental output with a clean build
on fixtures. Graph queries always name a source snapshot; stale graphs must be
labeled or rebuilt, never silently presented as current.

Integrate graph retrieval into context with inclusion reasons and budgets. UI starts
with searchable symbol details and incoming/outgoing relationships, then adds a
bounded interactive neighborhood view with click-through to source and evidence.

Deliverables: one accurate pilot-language graph, context integration, impact view,
and graph/no-graph variants ready for evals. Delay cross-repository graphs, ownership
inference and extensive Git-history analytics.

### F. Evaluation product

Add versioned suites/cases/fixtures and scorers over ordinary engineering runs.
Each case/variant/repetition gets an isolated workspace and runtime session.
Keep held-out tests and reference patches outside agent-accessible context.

Deterministic metrics: task success on protected checks, build/test outcomes, scope
violations, retries, elapsed time, context size and harness failures. Semantic
scoring: per-criterion coverage with cited evidence, versioned rubric and explicit
invalid/uncertain outcomes. Semantic judgment does not replace required objective gates.

Support `eng eval run`, `eng eval compare`, paired variants and persisted experiment
configuration. Begin with a curated small pilot suite; use repeats for changes whose
effects could be lost in model variance. Report denominators, missing/error outcomes,
paired deltas and individual runs before aggregate percentages.

UI: suite execution history, side-by-side comparisons and drill-down to task diff,
context, evidence and failures. Review precision requires labeled findings; expose
the labeling workflow and avoid reporting unsupported recall claims.

Deliverables: a baseline comparison of graph context off/on plus a skill/workflow
change comparison. Set task-quality release thresholds from pilot evidence rather
than inventing a success percentage in advance.

### G. Publication and review comments

Implement the actual enterprise Stash/Bitbucket adapter for the deployed version.
Do not assume cloud endpoints match the internal installation. Reuse approved
authentication and keep write credentials in the deterministic publication path.

Approval binds repository, source candidate, target branch/revision as appropriate,
verification set, policy and proposed publication payload. Changes invalidate it.
Present branch push, PR creation and selected review-comment publication explicitly
as the proposed effect set; do not implicitly authorize merge or unrelated Jira edits.

Persist action intent and stable identity before network calls. Reconcile remote
state after lost responses. If the server cannot establish whether an action already
happened, block for reconciliation instead of automatically creating duplicates.
Comment identity includes candidate/finding identity and validated diff location.

Deliverables: inspect → approve → push/create PR → publish selected findings, through
CLI and UI; stale approval, duplicate request, server timeout and partial publication
tests. Validate against an approved pilot repository before calling this release-ready.

### H. Packaging, reliability and handoff

Provide workstation setup, approved image preparation, prebuilt UI assets, pinned
dependencies, upgrade/migration instructions, backup/restore and storage diagnostics.
Add explicit retention and cleanup previews that protect active runs and referenced
artifacts. No automatic removal of user branches/worktrees or shared Docker resources.

Operational metrics come from the same state/events: completion/block/failure,
resume outcomes, cancellations, phase duration, invocation/retry counts, test failures,
publication reconciliation and duplicate actions prevented where observable.

Exercise restart, disk-full, unavailable DB/Docker/internal systems, corrupt artifacts,
invalid credentials, revoked approval, changed target branch and server disconnect.
Add a support export that omits secrets and lets the operator choose included source
and ticket content. Document known isolation/authentication boundaries honestly.

Deliverables: installable local release, user guide, operator runbook, migration and
restore test results, real pilot evidence, and a known-limitations list.

## Definition of a well-rounded V1

The release is ready when an engineer on the actual cloud workstation can:

1. Configure Gemini and a pilot repository without editing harness source.
2. Start from Jira or a fixture, in the CLI or forwarded browser UI.
3. Get an isolated implementation, independent verification and a review report.
4. Explain the selected context, changed files, requirements and execution evidence.
5. Resume/reconcile interruption without concurrent writers or silent duplicate effects.
6. Explore a correct graph for the pilot language and compare golden-task variants.
7. Approve the exact candidate and publish the intended PR/comments.
8. Back up, upgrade, diagnose and clean up the tool using documented procedures.

Fake-runtime success alone does not meet the release gate. Require at least one
real end-to-end pilot task on the enterprise workstation, including approved
publication, plus regression/recovery tests. A functioning Docker command alone
does not constitute validation of the container security/network profile.

## Choices and inputs

Recommended defaults: single operator, one local worker, serial phases, Docker on
the Linux cloud workstation, SQLite, React, trusted declarative workflows, Gemini
CLI only and internal/preloaded dependencies. Retain JSON workflow definitions;
YAML can be an authoring convenience later if the existing pipeline needs it.

Needed to tailor deployment and migrate the pipeline:

- Existing 14-phase definitions and their skills/prompts.
- One pilot repository's primary language, build/test commands and branch conventions.
- Installed Gemini version, authentication method, approved configuration/extensions.
- Docker daemon/context, approved image/registry and workstation network constraints.
- Jira/Confluence/Stash access mechanisms and the internal product/API versions.

These are inputs to the corresponding milestone, not reasons to stop unrelated
local implementation. Missing workstation access or credentials remain explicit
deployment blockers; mocks do not count as successful enterprise integration.

## Deliberately deferred

Other model runtimes, autonomous agent conversations, distributed workers, complex
scheduling, multi-user RBAC, Kubernetes/Kafka, Neo4j/vector storage, public SaaS,
automatic merge, broad Jira status automation, cross-repository graph analytics
and a generic plugin marketplace.

Approval requested: implement milestones A–H in this sequence, using Docker as the
preferred workstation execution backend and keeping publication human-approved.
No implementation changes have been made as part of this planning request.
