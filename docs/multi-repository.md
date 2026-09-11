# Workspaces and multi-repository runs

One local harness installation can register repositories anywhere on the workstation.
A **workspace group** selects an ordered set of those profiles. A multi-repository
run is a durable parent run plus an isolated candidate-producing child run per repository.
It does not reuse or modify your original checkouts, and it does not require Docker.

## Register or import a workspace

First register repository profiles with their actual checks and skills. Use the same
absolute `--data` path for the CLI and server when moving between terminal directories.

```sh
eng repo add payments-api.json --data /workstation/harness-data
eng repo add payments-ui.json --data /workstation/harness-data
eng workspace add examples/workspace.json --data /workstation/harness-data
eng workspace list --data /workstation/harness-data
```

Alternatively import a VS Code multi-root workspace:

```sh
eng workspace import payments /workspaces/payments.code-workspace --data /workstation/harness-data
```

Import supports JSON comments, trailing commas, and relative or absolute local folder
paths. Every folder must be a Git repository root. Existing profiles are reused by
canonical path; ambiguous matches, duplicate roots, variable substitutions and URI
folders are rejected. New profiles have no guessed verification commands: configure
them before running. Import does **not** execute or copy VS Code tasks, settings,
extensions, credentials or terminal commands. It will not overwrite an existing group.

Use the **Workspaces** screen to import, inspect and edit groups. The **Repositories**
screen remains the place to configure each repository's language/build checks and skills.

## Group profile and cross-repository checks

See [examples/workspace.json](../examples/workspace.json). Replace its repository IDs
and trusted integration-test script path with your own. Members must be ordered so
dependencies precede consumers. `task` adds repository-specific scope to the shared
ticket; completed dependency candidates are provided as explicitly attributed context.
The harness is a sequential coordinator, not an agent conversation framework.

Checks use argument arrays, not shell interpolation. `{workspace:repository-id}` in
an argument is replaced with that child's isolated worktree path. `cwdRepository`
selects the working directory. The trusted check script can build packages, start test
services and validate contracts across these paths; it must manage its own service
cleanup. Cross checks do not install dependencies automatically, require no internet,
and currently run on the host rather than through the optional single-repo Docker backend.
They use observed process exit status and preserve supervisor evidence. Use a trusted
test script outside agent-writable worktrees when checks must resist source tampering.

At least one required repository check per member and one required cross-repository
check are mandatory. Cross checks must not modify candidate source or commits; the
entire revision set is rechecked after each command. Ignored build outputs are allowed.
This is cooperative worktree isolation, not an OS sandbox against a hostile same-user process.

## Run and approve

```sh
eng run ENG-428 --workspace payments --ticket ticket.json --data /workstation/harness-data
eng status ENG-2026-000001 --data /workstation/harness-data
eng approve APPROVAL_UUID --hash SUBJECT_HASH --data /workstation/harness-data
eng resume ENG-2026-000001 --data /workstation/harness-data
```

The UI run form also accepts a workspace group. Parent run details link to every
child's diff, artifacts, review, verification and publication record. Approval cards
show the complete repository/revision set. CLI status includes child IDs; inspect
their logs individually for full agent traces. The parent event stream records child
lifecycle transitions, integration checks and linked publication progress.

Lifecycle:

1. Freeze group/profile/workflow/skill definitions and every base commit at creation.
2. Snapshot the shared ticket once. Without supplied text, use the installed Gemini
   CLI's Jira MCP. The first member with an explicit `ticketSource` supplies the
   configuration, otherwise the first member does. Explicit `jira-api` retrieval is
   also available. All children receive that same snapshot, comments and provenance.
3. Run each child in its own worktree, in dependency order. Per-repository verification
   and review remain required. Terminal approval/publication phases are deferred to the parent.
4. Run deterministic integration checks against the complete candidate revision set.
5. Request **one linked approval**, bound to every candidate, target revision, diff,
   repository verification/review hash, profile hash and cross-verification evidence.
6. Publish sequentially through existing idempotent Stash adapters. PR descriptions
   contain the common parent run identifier and companion repository IDs. The parent
   stores the resulting PR IDs/URLs together; no external backlink comments are silently posted.

A child marked `COMPLETED` means its **candidate workflow** finished, not that its PR
was published. Resume/cancel the parent; direct child resume/publication cannot bypass
the linked approval. Members without Stash configuration finalize local candidates.

## Recovery and limitations

Child membership is embedded in immutable run configuration, so a crash immediately
after child allocation is recoverable without creating another child. Existing phase
ownership, process reconciliation, bounded attempts and artifact verification apply
to both parent and children. Resume uses the frozen profiles, not newly edited groups.

Publication is **not atomic across repositories**. If one PR succeeds and another
fails, successful effects remain recorded. Resume reconciles and skips completed
effects; ambiguous external outcomes block for manual inspection. No PR is deleted
or rolled back automatically. Cancelled runs can therefore have partial publication.

If any candidate or target changes, linked approval is invalidated at the next
approval/publication validation. Once invalidated, create a new run for fresh evidence
and approval; this release does not automatically rewrite completed child phases or regenerate a
changed candidate set. A failed integration check never generates approval, and there
is no automatic cross-repository repair loop yet.

V1 is bounded to 1–12 distinct Git repositories per group, sequential execution,
30 minutes per child orchestration phase and a total cross-check timeout below 1,700
seconds. Custom child workflows must include `intake`, `verify` and `review` providers;
any approval/publish providers must form a terminal suffix. Extra human phases can
block a child and require workflow-specific handling. General interleaved cross-repo
planning, atomic merges, coordinated deployment, URI workspace import and multi-repo
golden-suite scoring are not included.

API: `GET/POST /api/v1/workspaces`, `POST /api/v1/workspaces/import` with `{id,path}`,
and `POST /api/v1/runs` with `{workspaceId,ticket,graphContext}`. These use the same
authenticated local service and policy boundaries as repository runs.
