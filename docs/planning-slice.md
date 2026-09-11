# Planning slice: setup and operation

Historical slice notes: the current combined CLI requires the product dependencies.
For the installed Gemini CLI workflow and UI, use [the product guide](product-guide.md).

Implemented scope: deterministic intake → Gemini requirements analysis → Gemini
implementation plan. The coordinator owns progress and independently checks output
shape, ticket identity, base revision, acceptance-criterion references and artifact
integrity. A passing planning run says nothing about build/test success or whether
a human has approved the plan.

## Requirements

- Node 24.13.x; TypeScript executes through Node's native type stripping.
- Git and `ps` accessible locally.
- Installed, enterprise-approved Gemini CLI supporting `--output-format stream-json`.
- macOS `sandbox-exec`, or Linux `/usr/bin/bwrap` with permitted user namespaces.
- Local durable storage. Do not put the SQLite database on a network filesystem.
- The normal approved network route and authentication to Gemini. No external
  retrieval is performed by the harness; no runtime package downloads occur.

There are zero production npm dependencies. `typescript` and `@types/node` are
pinned development dependencies in the lockfile. Use the enterprise registry or
an approved cache for `npm ci --ignore-scripts`. The lockfile was generated against
the public npm registry on the development machine; mirror/remap package resolution
according to your organization's approved installation process.

Gemini is not installed on the development machine used for this implementation.
Protocol behavior is tested with a real subprocess fixture. macOS filesystem
containment has been tested with Node; the Linux profile and real Gemini CLI still
need their workstation smoke test. There is no unrestricted execution fallback.

## Configure the runtime

Keep trusted runtime configuration outside the target repository. For example,
`/approved/config/eng-runtime.json`:

```json
{
  "executable": "/usr/local/bin/gemini",
  "readOnlyPaths": ["/usr/local"],
  "inheritEnvironment": ["GEMINI_API_KEY"],
  "environment": {"PATH": "/usr/local/bin:/usr/bin:/bin"}
}
```

Change executable, mounts and environment names for the installed enterprise
runtime. API-key authentication above is only an example; an approved Vertex or
gateway setup may use different environment variables and specific credential or
CA files. Inherited values are passed only to the runtime, not copied into run
configuration. Do not pass Jira/Stash publication credentials. Literal environment
configuration is supported for non-secret settings such as executable search paths.

Mount only runtime installation directories and explicitly required support files.
The target repository and harness data must not be inside any exposed read root.
The sandbox allows system runtime files and a fresh invocation scratch directory.
The agent receives selected source content through stdin; it never runs in the
source checkout. Its HOME is scratch, so ambient personal Gemini configuration,
OAuth state and extensions are not inherited automatically. Enterprise integration
may require an adapted approved profile if authentication depends on those files.

A deny-all tool policy is installed in the fresh Gemini home. Observed tool calls
also block the planning phase. Tool logs are observations, not a pre-execution
authorization mechanism; OS filesystem containment protects source/control files.
Existing administrator policies can override Gemini user policies and must be
reviewed in the live workstation smoke test. Network restrictions come from the
enterprise workstation: the process profile permits outbound traffic for Gemini
and is not itself an endpoint firewall. Do not use it to claim a stronger network
boundary than the workstation provides.

Protocol references: [Gemini headless output](https://geminicli.com/docs/cli/headless/)
and [Gemini policy precedence](https://geminicli.com/docs/reference/policy-engine/).
Installed-version behavior must be checked with the smoke test, not inferred from
these references alone.

## Run

Provide a ticket JSON object with `key`, `title`, `description` and a nonempty
`acceptanceCriteria` string array. See [the fixture](../tests/fixtures/ticket.json).

```sh
node apps/cli/bin/eng.mjs run JIRA-428 \
  --repo /path/to/pilot-repository \
  --ticket /path/to/ticket.json \
  --files src/service.ts,src/service.test.ts \
  --runtime /approved/config/eng-runtime.json \
  --data /canonical/local/eng-data
```

The CLI emits the immutable display ID and progress events, then returns status,
phase attempts and artifact IDs. `--json` suppresses progress lines and formats
the final stdout result for scripts. Errors/progress use stderr. Exit codes are
0 for completed planning, 1 for failed/blocked execution and 130 for cancellation.

`eng` is the package's bin entry; the commands can also be invoked with
`npm run eng -- ...`. No global installation is needed when using the Node path
above. All commands must use the same `--data` location (default `.harness` in
the current directory).

```sh
node apps/cli/bin/eng.mjs status ENG-2026-000001 --data /canonical/local/eng-data
node apps/cli/bin/eng.mjs logs ENG-2026-000001 --after 0 --data /canonical/local/eng-data
node apps/cli/bin/eng.mjs artifact ENG-2026-000001 --artifact ARTIFACT_UUID --data /canonical/local/eng-data
node apps/cli/bin/eng.mjs resume ENG-2026-000001 --runtime /approved/config/eng-runtime.json --data /canonical/local/eng-data
node apps/cli/bin/eng.mjs cancel ENG-2026-000001 --data /canonical/local/eng-data
```

`status`, `logs` and `artifact` never advance phases. Cancellation is recorded as
intent; an active coordinator stops the invocation. If no coordinator is active,
`resume` reconciles process state and finishes cancellation. Ctrl-C requests local
cancellation and waits for owned-process cleanup.

## Context and artifacts

Only explicitly selected, committed regular files from the resolved HEAD commit
are included. Uncommitted changes are intentionally absent. Source bytes are capped
at 256 KB; the complete phase prompt is capped at 320 KB. Binary files and symlinks
are rejected. Omitted paths are recorded. Select a small representative context;
automatic repository investigation and graph retrieval are later slices.

Requirements sees the ticket and selected files. Planning additionally sees the
selected requirements output. A retry sees the last validator/runtime failure,
not previous full conversations. Every bundle records source hashes and selection
reasons. Runtime/skill/workflow content is pinned in immutable run configuration.

SQLite stores runs, phases, attempts, artifact bindings and one sequenced event
stream. Content lives in `blobs/<sha256>`. Invocation directories retain sanitized
stdout/stderr, process identity, and observed exit metadata. These are also bound
as artifacts after normal attempt completion/failure. Streams left by a killed
coordinator remain in their invocation directories for recovery inspection.

JSON reports and readable report strings are separate artifacts; the artifact
command returns their stored JSON representation. The run manifest lists evidence
and provenance. Known secret patterns are redacted before logs/streams are saved;
redaction is best effort and source/ticket inputs with detected secrets are rejected.
Protect local storage as enterprise code and ticket data. There is no automatic
retention deletion in this slice.

## Recovery contract

SQLite changes and phase events commit together. Artifact blobs are flushed and
renamed before their references are committed. Selected outputs become visible to
dependent phases only with the passing phase transaction.

One coordinator owns a run, with a persisted generation that fences stale database
writes. Ownership recovery checks PID/start identity rather than a timer alone.
The supervisor has a separate process, persisted identity, launch handshake and
deadline. It terminates the invocation process group if the coordinator disconnects.
An unknown launch or surviving group blocks recovery rather than admitting another
process. Do not manually clear such markers without establishing process state.

After a crash, `resume` validates configuration/artifact hashes, reconciles invocation
state, marks unfinished attempts interrupted and starts a fresh attempt. It does
not reattach to Gemini conversations. Completed phases are not rerun. Interrupted
attempts consume the same persisted budget (two attempts per phase by default).
Exhausted or terminal failed runs are not silently reopened; create a new run.

If an artifact is corrupt/missing, the run blocks before more work. Restore that
exact content from backup and resume. For backups, stop all coordinators and copy
the complete data directory including SQLite journal files and blobs; a hot copy
of the database alone is not supported.

The local ledger protects against mistakes and corruption, not a malicious user
with write access to the entire database and blob store. It is not a compliance
audit service.

## Validation

```sh
npm run typecheck
npm test
```

Tests exercise subprocess JSONL parsing, incorrect claims, missing final records,
failed exit codes, timeout, cross-connection cancellation, writer fencing, context
selection, artifact corruption, SIGKILL recovery, state transitions and OS containment.
The fixture runtime exists only in tests and is not selectable through the CLI.
No test calls a model by default.

After installing/configuring Gemini on the workstation:

```sh
ENG_LIVE_RUNTIME=/approved/config/eng-runtime.json node --test tests/live.test.ts
```

This explicitly opts into two model invocations, with bounded retries. Inspect the
generated context, events and reports before using real ticket data.

## Deliberate limits and next slice

The trusted workflow is JSON rather than YAML; this avoids an execution dependency.
The compiler supports exactly this three-phase planning contract and serial
dependencies. Human gates, skip predicates and general workflow providers remain
future work. The public service/runtime boundaries permit them without implementing
a generic workflow language prematurely.

CLI configuration validation, ticket loading, source snapshotting and runtime probes
are preflight; their failures currently return before a run ID is allocated. Intake
persists the validated snapshots. This is a documented difference from the broader
architecture's proposed fully durable intake; add a durable preparation record when
the real Jira adapter introduces network-dependent intake.

No React UI, Jira/Confluence/Stash adapters, code changes, worktrees, test execution,
graph index, semantic scorer, or publication is implemented. The next vertical slice
is one isolated implementation phase followed by independent verification against
an exact candidate revision, retaining this evidence and recovery model.
