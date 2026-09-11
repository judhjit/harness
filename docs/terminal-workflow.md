# Interactive Gemini approvals

Use this path when organizational policy requires approvals in a terminal. The
harness does not override that policy and cannot grant Gemini permissions from its
web UI. PR publication approvals remain a separate harness gate.

## Quick start

Restart the server after updating and rebuilding the UI. Start a **new run** if a
previous run is already FAILED or CANCELLED. Product profiles now default to terminal
interaction when `runtime.interaction` is omitted; you can make it explicit:

```json
"runtime": {
  "executable": "gemini",
  "args": [],
  "environmentNames": [],
  "mode": "workstation",
  "interaction": "terminal"
}
```

From a real VS Code terminal, either start and execute a run:

```sh
eng run ENG-428 --workspace payments --terminal --data /workstation/harness-data
```

Or start it in the browser and follow its **Terminal approval required** handoff:

```sh
eng terminal ENG-2026-000001 --data /workstation/harness-data
```

Use the same absolute data directory as the server. The UI displays a copyable
command using the actual directory. For multi-repository work, attach to the
**parent**, not an individual child. Ownership fencing prevents two coordinators
from driving the same run concurrently. A busy owner must finish/release first.

## What happens for each agent phase

1. The harness persists a phase-specific prompt and context in a private local file.
2. Gemini starts with the actual terminal attached to stdin/stdout/stderr, in the
   appropriate repository worktree (or `ticketSource.cwd` for Jira retrieval).
3. Gemini reads the prompt file. You approve or reject tool requests **inside Gemini**,
   using the normal managed policy. An organization-level denial remains a denial.
4. Ask Gemini to return the prescribed JSON in its final chat response. Copy it,
   then exit Gemini with `/quit`. Do not ask it to save a report through a shell tool.
5. Paste the JSON into the harness prompt, then enter `.end` on a separate line.
   Invalid JSON can be pasted again. Enter `.pause` instead to defer submission.
6. The harness validates the response schema, checks source scope, captures the
   candidate, and runs build/tests itself. It advances to the next phase or waits
   for publication approval. A pasted report cannot declare that tests passed.

After `.pause`, run `eng terminal RUN_ID` again with the same data directory. A cleanly
exited Gemini session awaiting a result does not need to rerun; the harness requests
the JSON again. Waiting for terminal attachment/result submission does not consume
another phase attempt. Repair handoffs retain their failed-check context and resume
before capturing and independently checking the repaired candidate.

The integration uses Gemini's documented
[`--prompt-interactive` mode](https://geminicli.com/docs/reference/configuration/).
It does not combine interactive mode with `--prompt`, piped stdin, or structured
`--output-format`. Long phase prompts are handed off through the local file to avoid
command-line argument limits. Reading that file may itself require an approval.

## Evidence and recovery boundaries

Interactive sessions do **not** expose the headless structured tool stream here.
The harness records session/process metadata, launch and exit evidence, prompt hashes,
and the operator-submitted response. It does not scrape terminal text, inject approval
keystrokes, claim complete tool traces, or claim operator-pasted JSON is independently
verified model output. Jira provenance records `resultDelivery: "operator-paste"`,
`toolTraceCaptured: false`, and model-mediated source claims. Deterministic build/test
commands retain their normal captured logs and observed exit evidence.

The live terminal UI and its approval conversations remain in the terminal. No
interactive browser terminal, transcript extraction, or automatic final-response
capture is included in this version. This first path is deliberately operator-assisted.

A supervisor tracks the terminal process and observed descendants. Cancellation,
timeout and lost parent connection stop recorded owned processes; it never kills a
whole shared terminal process group. Recovery blocks while recorded processes are
alive or launch/exit state is ambiguous. Very short-lived parents can leave detached,
unobserved grandchildren; this is not container/cgroup isolation. Native Gemini retains
the workstation user's filesystem and network access. Do not use it as a security
boundary against a hostile same-user process.

Phase/agent deadlines still apply while waiting for live approvals and entering
results (normally 10 minutes for coding agents and 2 minutes for ticket retrieval;
`ticketSource.timeoutMs` is configurable). Ctrl-C requests cancellation rather than
silently passing the phase. Closing the terminal mid-session may require another
attempt or manual process reconciliation; there is no automatic chat-session resume.
Terminal execution currently targets Linux/macOS workstations, not Windows consoles.

## Optional headless execution

Set `runtime.interaction: "headless"` only when your organization permits the needed
tools without interactive confirmation. The harness no longer adds `--approval-mode`
in either mode. Remove old approval/auto-approval overrides from `runtime.args`;
these are rejected rather than used to bypass policy. `eng terminal` or `--terminal`
can opt into a terminal for a nonterminal run even if its profile requested headless.

Offline automated evals need approved headless profiles or fixture runtimes. Terminal
mode requires a human and is not an unattended eval configuration. Validate one Jira
read and one edit/test cycle on your managed Gemini installation before relying on it.
