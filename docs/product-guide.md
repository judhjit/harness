# Workstation product guide

## Start with the installed Gemini CLI

Open the VS Code Server terminal where `gemini` already works. The default product
uses that command and the existing workstation HOME/authentication. It requires no
Gemini Docker image. Docker is an optional per-check backend, only when a developer
chooses a locally available image.

```sh
npm ci --ignore-scripts
npm run build:web
node apps/cli/bin/eng.mjs doctor
node apps/cli/bin/eng.mjs serve
```

Use Node 24.13.x. Dependencies are pinned in the lockfile; prepare them through the
organization's normal approved registry/cache. Build output contains React and CSS
locally, with no CDN. The execution path performs no npm installs or image pulls.

Forward port 4310 privately using VS Code. Open the forwarded URL and enter the
local session token printed by `serve`. If the forwarded hostname differs from
localhost, start with `--origin https://your-forwarded-host` (repeat for additional
trusted origins). The server binds only to 127.0.0.1. Keep the token private; this
is a single-operator application, not a multi-user identity system.

## Register repositories and your nine phases

For workspace grouping, VS Code multi-root import, coordinated multi-repository runs
and linked approvals, see [the multi-repository guide](multi-repository.md).

Copy a profile from `examples/profiles/`, replace its local path/base and check
commands, then import it:

```sh
node apps/cli/bin/eng.mjs repo add my-repo.json
node apps/cli/bin/eng.mjs repo list
```

Profiles support Java (Maven/Gradle commands), Node, Python and React. Language labels
do not cause the harness to guess or execute commands. Configure the actual commands
for each repository. At least one required check is necessary for the bundled
engineering workflow. Optional JSON test reports can supply `tests`, `numTotalTests`
or `summary.num_tests`; set `minTests` if a nonempty test count is a gate. Report
paths must be inside the worktree and should be ignored generated files. Other
report formats can be normalized by a configured command wrapper.

The bundled nine phases are a reference, not a claim to reproduce your private
pipeline. Set `workflow` in the profile to replace phase IDs, dependencies, providers,
outputs, retry limits and deadlines. Supported building blocks are `intake`,
`investigate`, `requirements`, `plan`, `implement`, `verify`, `review`, `approval`,
`publish`, and `agent-task`. Dependencies are listed before their consumers and
execution is serial. A skipped dependency does not automatically satisfy a consumer.

Set `skills` to prompt text or `file:/absolute/path/to/SKILL.md`. Contents are pinned
when the run is created. Custom reasoning phases use `provider: "agent-task"`, a
`skill`, an `inputs` list of selected artifact roles, an `outputSchema` (JSON Schema)
and `access: "read"` or `"write"`. These need no new runtime implementation.

```json
{
  "id": "architecture-check",
  "executor": "agent",
  "provider": "agent-task",
  "skill": "my-architecture-skill",
  "dependsOn": ["plan"],
  "inputs": ["requirements", "plan"],
  "output": "architecture-report",
  "access": "read",
  "outputSchema": {
    "type": "object",
    "required": ["summary"],
    "properties": {"summary": {"type": "string"}},
    "additionalProperties": false
  },
  "maxAttempts": 2,
  "timeoutMs": 300000
}
```

Publication retains independent candidate/verification/approval checks regardless
of custom model output. A schema-valid custom report cannot declare tests passed.
When replacing the whole reference flow, preserve the artifact contracts expected
by any reused providers; for example review consumes requirements, plan and verification.

## Run and inspect

```sh
node apps/cli/bin/eng.mjs run ENG-428 --repo payments --ticket ticket.json
node apps/cli/bin/eng.mjs status ENG-2026-000001
node apps/cli/bin/eng.mjs resume ENG-2026-000001
node apps/cli/bin/eng.mjs cancel ENG-2026-000001
```

Use the same `--data /canonical/local/path` across commands and the server. Runs
created through the browser are queued for its local worker. Foreground CLI runs
use the same coordinator. The browser can close without cancelling a queued run.
Cancellation remains explicit. After server restart, queued/interrupted jobs are
reconciled against run ownership and process state.

Each run gets a Git worktree and harness branch. The harness captures commits,
diffs, allowed-path checks, process exit evidence and review output. A bounded
repair loop follows independently failed checks. Failed attempts and their evidence
remain inspectable. File, prompt and command outputs are artifacts; the run view
includes timelines, live events, candidate diffs, checks and approvals.

The installed CLI now defaults to **terminal interaction**, inheriting managed
permissions without `--approval-mode`. Browser runs pause for `eng terminal RUN_ID`;
approve tools in that VS Code terminal, then paste the final JSON back into the
harness. See [the terminal workflow](terminal-workflow.md). Approved headless setups
can explicitly set `runtime.interaction: "headless"`.

## Integrations and publication

### Optional description: retrieve through Gemini's Jira MCP

Leave the description blank to have the installed Gemini CLI retrieve the ticket and
comments through its existing Jira MCP. No separate Jira API token is needed for this
path. Supplying a nonblank description or `--ticket` JSON with a description bypasses
retrieval. Start a **new run** if an earlier run is already terminal/failed.

```sh
eng run ENG-428 --repo payments
eng run ENG-428 --workspace payments-product
```

Intake launches Gemini from the repository path by default, with the configured
`runtime` executable, arguments and named environment variables. If your working MCP
configuration lives in a different VS Code workspace directory, add this optional
field to the repository profile:

```json
"ticketSource": {
  "provider": "gemini-mcp",
  "cwd": "/workspaces/my-gemini-workspace",
  "timeoutMs": 120000,
  "instructions": "Use our corporate Jira MCP read tools to fetch the issue and its comments."
}
```

Use the same directory where Gemini can already read Jira. This starts a fresh
CLI invocation; it does not attach to an existing conversation. In terminal mode,
approve MCP read tools in Gemini and paste its final JSON back into the harness.
Headless mode requires pre-permitted tools. The harness does not enable blanket auto-approval,
install an MCP server, or connect directly to the MCP endpoint. If your MCP config
references environment variables, include the required names in
`runtime.environmentNames` and start the harness from the configured terminal.
Keep secrets out of `instructions` and profiles.

For a workspace group, the first member with an explicit `ticketSource` supplies the
retrieval configuration; otherwise the first member does. The parent retrieves once
and shares the validated snapshot, comments and provenance with all children.

The harness validates the ticket key and response structure. Headless mode requires
observed tool-result activity; terminal mode labels the response as operator-pasted
without claiming captured tool traces. Both save the snapshot as an artifact. Retries
reuse a persisted validated snapshot rather than fetching a different ticket version.
It cannot independently prove that Gemini faithfully reproduced Jira: source URI/tool
names are model-reported, and the snapshot is labelled **model-mediated, not independently
verified**. Native CLI permissions are not an OS-enforced read-only boundary.
An unavailable MCP, denied access, wrong key or malformed response blocks progress
through normal bounded phase failure handling; it never silently invents a ticket.

### Epic child details

For **epics**, the default Gemini/MCP intake reads the issue type, enumerates all
pages of child issues and recursively retrieves nested subtasks, including completed
items. Each descendant records its key, immediate parent, type, status, title,
description, acceptance criteria, comments and claimed source URI/tool. A genuinely
empty child description is allowed; a missing detail record is not. Comments are
bounded to 100 per issue, with truncation explicitly recorded.

The flattened hierarchy travels with the shared ticket snapshot into repository
contexts and is inspectable in the run's **Epic child items** section. Requirements
instructions account for child keys and flag scope ambiguities, not silently filter
out completed issues. This does not automatically create one run or PR per Jira child.

Incomplete enumeration, inaccessible children, mismatched counts, duplicate keys,
cycles or missing parents stop intake before implementation. The safety caps are
200 descendants and 400 KB of retrieval output; split larger epics into child-scoped
runs. Counts, parent relationships and completeness remain model-reported, not proof
that Jira permissions exposed every issue. No independent completeness claim is made.

Inline descriptions still bypass remote fetching. To supply a known epic offline,
include `isEpic: true` and a complete `hierarchy` in the ticket JSON (the schema is in
`Ticket` in `packages/core/src/contracts.ts`). Existing snapshots are not automatically
expanded; start a new run to retrieve an epic hierarchy.

Direct Jira API epic expansion is not implemented: recognized epics on that path
are blocked with instructions to use Gemini/MCP or a complete supplied snapshot.
Custom Jira type names should use the MCP path with deployment-specific guidance.

### Optional direct API connections

Import a trusted connection profile with `eng integration add integration.json`:

```json
{
  "id": "internal-jira",
  "kind": "jira",
  "baseUrl": "https://jira.internal.example",
  "tokenEnvironment": "ENG_JIRA_TOKEN"
}
```

Supported adapters target Jira Server-style `/rest/api/2`, Confluence content APIs,
and Stash/Bitbucket Server-style `/rest/api/1.0`. They use HTTPS, bounded responses,
timeouts, explicit paths and bearer-token environment references. Internal versions,
authentication extensions and deployment-specific fields still require validation
against your actual systems. There is no implicit public-cloud API fallback.

For direct Jira API retrieval instead of Gemini/MCP, set repository
`integrations.jira` to its connection ID **and** set
`"ticketSource": {"provider": "jira-api"}`. An API failure does not silently fall
back to a different source.
Configure `stash`, `project` and `slug` for publication, with an explicit branch
name in `base`. Without Stash, approval completes a local candidate; it does not
pretend a PR was published.

Approval binds candidate, target, diff, verification, review and profile hashes.
The UI lets you inspect the diff before deciding. CLI equivalent:

```sh
node apps/cli/bin/eng.mjs approve APPROVAL_ID --hash SUBJECT_HASH
node apps/cli/bin/eng.mjs resume RUN_ID
```

Publication pushes the candidate branch and creates a PR. It never merges it or
changes Jira status. After publication, select review findings in the UI to create
a separate comment proposal, approve it, then publish. Initial comment support posts
general PR comments containing exact file/line references, not inline diff anchors.
CLI equivalents are `eng comments RUN_ID finding1,finding2` and, after approval,
`eng comments publish APPROVAL_ID`.

Stable markers and recorded intent support reconciliation. If a request's outcome
is unknown and no matching remote object can be established, the action blocks
rather than creating a possible duplicate. An operator must inspect that remote
state; this version does not provide a blanket “force retry publication” button.

## Graphs and evals

Graph indexing is entirely external. See [graph providers](graph-providers.md) for
command and snapshot contracts. Graphify and other tools can be connected with
wrappers; there is no built-in indexer or product-specific Graphify dependency.

```sh
node apps/cli/bin/eng.mjs graph PaymentService --repo payments
node apps/cli/bin/eng.mjs eval run suite.json
node apps/cli/bin/eng.mjs eval compare EXPERIMENT_UUID
```

An eval suite has a name, repetitions, cases and variants. Each case specifies a
repository ID, ticket, optional expected files and independent scorer commands.
Scorer argument strings may contain `{workspace}`, replaced without shell evaluation.
Store scoring scripts outside agent worktrees; they are not added to phase context.
Without a behavioral scorer, a completed workflow is explicitly unscored and is
not counted as solved. Native workstation execution is not an OS-enforced boundary
between an agent and files elsewhere in its user account.

Variants can change graph context, graph provider or skill text. Every case uses
a fresh worktree; approval/publication phases are removed from eval workflows.
The dashboard includes denominators, errors, runtime, attempts, coverage judgments,
scorer evidence and links back to runs. Model judgments are distinct from objective
command results. Review precision is not reported without human labels.

## Isolation, operation and limits

Git worktrees isolate normal development changes; they do not sandbox a process
running as the same workstation user. The installed Gemini CLI retains its existing
authentication/configuration. The harness checks Git identity, source scope and
candidate stability, but does not claim it can prevent a hostile process from using
ambient credentials or changing all files accessible to that user. Stronger OS
isolation is an explicit deployment decision. Stash credentials should not be added
to `runtime.environmentNames`; personal credential stores may still be accessible
to same-user processes.

Optional `dockerImage` on a check selects Docker execution. The image must already
exist locally and provide `/usr/bin/timeout` plus the check executable. The adapter
resolves image identity, disables networking, caps resources and mounts only the
worktree. It does not mount the Docker socket. Owned containers remain available
for inspection; remove exact stopped container IDs only after checking their labels.

`eng backup /new/destination` supports an offline whole-directory backup. Stop the
server and all coordinators first; the command refuses known live owners. Restore
only with the application stopped. Forward migrations preserve existing planning
runs. There is no automatic deletion of branches, worktrees or evidence.

The old three-phase planning CLI remains available with `--runtime runtime.json`.
It retains its stricter snapshot/sandbox behavior; new registered-repository runs
use the installed-CLI profile described here.

Run `npm run typecheck`, `npm run build:web`, and `npm test`. Browser tests use an
existing Chrome (override with `ENG_CHROME`) and skip if unavailable. A real Gemini
and enterprise publication run remains a deployment acceptance gate; fixture tests
are not proof that internal authentication/API versions are compatible.
