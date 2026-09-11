import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";

let token = sessionStorage.getItem("eng-token") ?? "";
async function api(path: string, body?: unknown) {
  const response = await fetch(`/api/v1${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error);
  return value;
}
function Badge({ status }: { status: string }) {
  return <span className={`badge ${status?.toLowerCase()}`}>{status}</span>;
}
function Json({ value }: { value: unknown }) {
  return <pre>{JSON.stringify(value, null, 2)}</pre>;
}
const repoExample = {
  id: "service",
  name: "Service",
  path: "/path/to/repository",
  base: "main",
  languages: ["java", "node", "python", "react"],
  checks: [
    {
      id: "tests",
      executable: "npm",
      args: ["test"],
      timeoutMs: 300000,
      required: true,
    },
  ],
  runtime: {
    executable: "gemini",
    args: [],
    environmentNames: [],
    mode: "workstation",
    interaction: "terminal",
  },
  skills: {},
  repairAttempts: 1,
};
function App() {
  const [authenticated, setAuthenticated] = useState(!!token);
  const [page, setPage] = useState("Runs");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [runs, setRuns] = useState<any[]>([]);
  const [repos, setRepos] = useState<any[]>([]);
  const [workspaces, setWorkspaces] = useState<any[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [workspaceEditor, setWorkspaceEditor] = useState(
    JSON.stringify(
      {
        id: "product",
        name: "Product",
        repositories: [{ repositoryId: "service", dependsOn: [] }],
        checks: [
          {
            id: "integration",
            executable: "npm",
            args: ["test"],
            cwdRepository: "service",
            required: true,
            timeoutMs: 300000,
          },
        ],
      },
      null,
      2,
    ),
  );
  const [importId, setImportId] = useState("");
  const [importPath, setImportPath] = useState("");
  const [approvals, setApprovals] = useState<any[]>([]);
  const [evals, setEvals] = useState<any[]>([]);
  const [detail, setDetail] = useState<any>();
  const [tab, setTab] = useState("Overview");
  const [events, setEvents] = useState<any[]>([]);
  const [artifact, setArtifact] = useState<any>();
  const [phase, setPhase] = useState("");
  const [repo, setRepo] = useState("");
  const [key, setKey] = useState("");
  const [description, setDescription] = useState("");
  const [graphContext, setGraphContext] = useState(false);
  const [editor, setEditor] = useState(JSON.stringify(repoExample, null, 2));
  const [query, setQuery] = useState("");
  const [operation, setOperation] = useState("search");
  const [graph, setGraph] = useState<any>();
  const [node, setNode] = useState<any>();
  const [evaluation, setEvaluation] = useState<any>();
  const [settings, setSettings] = useState<any>();
  const [selectedFindings, setSelectedFindings] = useState<string[]>([]);
  const act = async (work: () => Promise<unknown>) => {
    setError("");
    setNotice("");
    try {
      await work();
    } catch (e) {
      setError(String(e));
    }
  };
  const refresh = async () => {
    const [a, b, c, d, w] = await Promise.all([
      api("/runs"),
      api("/repositories"),
      api("/approvals"),
      api("/evals"),
      api("/workspaces"),
    ]);
    setRuns(a);
    setRepos(b);
    setApprovals(c);
    setEvals(d);
    setWorkspaces(w);
    if (!repo && b[0]) setRepo(b[0].id);
  };
  useEffect(() => {
    if (!authenticated) return;
    void act(refresh);
    const timer = setInterval(
      () => void refresh().catch((e) => setError(String(e))),
      4000,
    );
    return () => clearInterval(timer);
  }, [authenticated]);
  useEffect(() => {
    if (!detail?.id) return;
    setEvents([]);
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`/api/v1/runs/${detail.id}/events`, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "text/event-stream",
          },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Event connection rejected");
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let pending = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          pending += decoder.decode(value, { stream: true });
          let end;
          while ((end = pending.indexOf("\n\n")) >= 0) {
            const packet = pending.slice(0, end);
            pending = pending.slice(end + 2);
            const data = packet.split("\n").find((l) => l.startsWith("data: "));
            if (data) {
              const event = JSON.parse(data.slice(6));
              setEvents((previous) => [...previous, event].slice(-1000));
              if (
                event.type.startsWith("PHASE_") ||
                event.type.startsWith("RUN_")
              )
                void api(`/runs/${detail.id}`).then(setDetail);
            }
          }
        }
      } catch (e) {
        if (!controller.signal.aborted)
          setError(
            "Live connection lost. Reopen the run to reconnect; execution continues.",
          );
      }
    })();
    return () => controller.abort();
  }, [detail?.id]);
  if (!authenticated)
    return (
      <main className="login">
        <div className="mark">E</div>
        <h1>Engineering Harness</h1>
        <p>Your engineering workflow, with evidence.</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            sessionStorage.setItem("eng-token", token);
            setAuthenticated(true);
          }}
        >
          <label>
            Local session token
            <input
              type="password"
              required
              onChange={(e) => (token = e.target.value)}
              autoComplete="off"
            />
          </label>
          <button>Connect to workstation</button>
        </form>
        <p className="muted">
          Run <code>eng serve</code> in your VS Code terminal and use its
          session token.
        </p>
      </main>
    );
  const openRun = async (id: string) => {
    setDetail(await api(`/runs/${id}`));
    setTab("Overview");
    setPhase("");
    setArtifact(undefined);
    setPage("Run");
  };
  return (
    <div className="shell">
      <aside>
        <a className="brand" href="#" onClick={() => setPage("Runs")}>
          <span className="mark">E</span> Engineering
          <br />
          Harness
        </a>
        <div className="workspace-label">LOCAL WORKSTATION</div>
        <nav>
          {[
            "Runs",
            "Repositories",
            "Workspaces",
            "Graph",
            "Evals",
            "Approvals",
            "Settings",
          ].map((item) => (
            <button
              className={
                page === item || (page === "Run" && item === "Runs")
                  ? "selected"
                  : ""
              }
              key={item}
              onClick={() => {
                setPage(item);
                setError("");
              }}
            >
              {item}
              {item === "Approvals" &&
              approvals.some((a) => a.status === "PENDING") ? (
                <span className="dot" />
              ) : null}
            </button>
          ))}
        </nav>
        <footer>
          <span className="dot" /> Installed Gemini CLI
          <br />
          <small>Local state · Explicit approvals</small>
        </footer>
      </aside>
      <main>
        <header>
          <div className="eyebrow">ENGINEERING CONTROL PLANE</div>
          <h1>{page === "Run" ? detail?.display_id : page}</h1>
          <p>
            {page === "Runs"
              ? "From ticket to verified candidate. Every decision inspectable."
              : page === "Graph"
                ? "Connect the graph tool your team already uses."
                : page === "Evals"
                  ? "Compare engineering outcomes, with individual runs behind every score."
                  : ""}
          </p>
        </header>
        {error && (
          <div role="alert" className="alert">
            {error}
            <button onClick={() => setError("")}>Dismiss</button>
          </div>
        )}
        {notice && (
          <div role="status" className="notice">
            {notice}
          </div>
        )}
        {page === "Runs" && (
          <>
            <section className="stats">
              <div>
                <strong>{runs.length}</strong>runs
              </div>
              <div>
                <strong>
                  {runs.filter((r) => r.status === "RUNNING").length}
                </strong>
                running
              </div>
              <div>
                <strong>
                  {runs.filter((r) => r.status === "COMPLETED").length}
                </strong>
                completed
              </div>
              <div>
                <strong>
                  {runs.filter((r) => r.status === "WAITING").length}
                </strong>
                awaiting decision
              </div>
            </section>
            <section className="panel">
              <h2>Start an engineering run</h2>
              <form
                className="run-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void act(async () => {
                    const run = await api("/runs", {
                      ...(workspaceId
                        ? { workspaceId }
                        : { repositoryId: repo }),
                      ticket: { key, title: key, description },
                      graphContext,
                    });
                    await openRun(run.id);
                  });
                }}
              >
                <label>
                  Workspace group (optional)
                  <select
                    value={workspaceId}
                    onChange={(e) => setWorkspaceId(e.target.value)}
                  >
                    <option value="">Single repository</option>
                    {workspaces.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name} · {w.repositories.length} repos
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Repository
                  <select
                    value={repo}
                    onChange={(e) => setRepo(e.target.value)}
                    required={!workspaceId}
                    disabled={!!workspaceId}
                  >
                    <option value="">Select repository</option>
                    {repos.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Jira ticket
                  <input
                    value={key}
                    onChange={(e) => setKey(e.target.value)}
                    placeholder="ENG-428"
                    required
                    pattern="[A-Z][A-Z0-9]*-[0-9]+"
                  />
                </label>
                <label className="wide">
                  Ticket description{" "}
                  <small>
                    Optional — Gemini retrieves Jira details through your
                    configured MCP; terminal handoff may be required
                  </small>
                  <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Requirements and acceptance criteria…"
                  />
                </label>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={graphContext}
                    onChange={(e) => setGraphContext(e.target.checked)}
                  />
                  Use configured graph context
                </label>
                <button disabled={!repos.length}>Start run</button>
              </form>
            </section>
            <section className="panel">
              <h2>Recent runs</h2>
              {!runs.length ? (
                <p className="empty">
                  Register a repository, then start your first run.
                </p>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Run / ticket</th>
                      <th>Repository</th>
                      <th>Status</th>
                      <th>Updated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.map((r) => (
                      <tr key={r.id}>
                        <td>
                          <button
                            className="link"
                            onClick={() => void act(() => openRun(r.id))}
                          >
                            {r.display_id}
                          </button>
                          <small>
                            {r.ticket} · {r.title}
                          </small>
                        </td>
                        <td>{r.repository}</td>
                        <td>
                          <Badge status={r.status} />
                        </td>
                        <td>{new Date(r.updated_at).toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          </>
        )}
        {page === "Run" && detail && (
          <>
            <section className="run-heading">
              <div>
                <Badge status={detail.status} />
                <h2>
                  {detail.ticket.key} · {detail.ticket.title}
                </h2>
                <span className="muted">{detail.repository}</span>
                {detail.ticketProvenance?.modelMediated && (
                  <p className="muted">
                    Ticket retrieved through Gemini/MCP · model-mediated input,
                    not independently verified
                  </p>
                )}
              </div>
              <div className="actions">
                <button
                  className="secondary"
                  disabled={!!detail.parentRunId}
                  onClick={() =>
                    void act(async () => {
                      await api(`/runs/${detail.id}/resume`, {});
                      setNotice("Run queued for reconciliation.");
                    })
                  }
                >
                  Resume
                </button>
                <button
                  className="danger"
                  disabled={!!detail.parentRunId}
                  onClick={() =>
                    void act(async () => {
                      await api(`/runs/${detail.id}/cancel`, {});
                      setNotice("Cancellation requested.");
                    })
                  }
                >
                  Cancel
                </button>
              </div>
            </section>
            {detail.status === "WAITING" &&
              (detail.terminalRequest ||
                detail.children?.some((c: any) => c.terminalRequest)) && (
                <section className="panel">
                  <h2>Terminal approval required</h2>
                  <p>
                    Open a VS Code terminal and run the command below with the
                    same data directory as this server. Gemini approvals happen
                    in that terminal, not in this browser.
                  </p>
                  <pre>{detail.terminalCommand}</pre>
                  <p>
                    After each phase, copy Gemini's final JSON, exit Gemini, and
                    paste it back into the harness. Publication approval remains
                    separate.
                  </p>
                  <Json
                    value={
                      detail.terminalRequest ??
                      detail.children
                        .filter((c: any) => c.terminalRequest)
                        .map((c: any) => ({
                          repository: c.repository,
                          ...c.terminalRequest,
                        }))
                    }
                  />
                </section>
              )}
            {detail.ticket.hierarchy && (
              <section className="panel">
                <h2>
                  Epic child items · {detail.ticket.hierarchy.items.length}
                </h2>
                <p>
                  Complete reported hierarchy, including nested subtasks. Source
                  details remain model-mediated when retrieved through Gemini.
                </p>
                {detail.ticket.hierarchy.items.map((item: any) => (
                  <details key={item.key}>
                    <summary>
                      {item.key} · {item.title} · {item.status}
                    </summary>
                    <p>
                      {item.issueType} · Parent: {item.parentKey}
                    </p>
                    <pre>{item.description || "No description in Jira"}</pre>
                    <Json
                      value={{
                        acceptanceCriteria: item.acceptanceCriteria,
                        comments: item.comments,
                        commentsTruncated: item.commentsTruncated,
                        source: item.source,
                      }}
                    />
                  </details>
                ))}
              </section>
            )}
            {detail.parentRunId && (
              <section className="panel">
                <button
                  onClick={() => void act(() => openRun(detail.parentRunId))}
                >
                  Open parent run →
                </button>
                <p>
                  Candidate execution complete does not mean published.
                  Publication is controlled by the parent approval.
                </p>
              </section>
            )}
            {detail.children && (
              <section className="panel">
                <h2>Repository candidates and linked PRs</h2>
                <p>
                  Each repository has independent evidence. Publication is
                  sequential and may partially succeed.
                </p>
                {detail.children.map((child: any) => (
                  <div className="artifact" key={child.id}>
                    <button
                      className="link"
                      onClick={() => void act(() => openRun(child.id))}
                    >
                      {child.repository} · {child.display_id} →
                    </button>
                    <Badge status={child.status} />
                    <small>
                      Revision: {child.candidate?.revision ?? "Pending"}
                    </small>
                    <small>
                      {child.publication?.id
                        ? `PR #${child.publication.id}`
                        : child.publication?.mode === "local"
                          ? "Local candidate finalized"
                          : "Not published"}
                    </small>
                    {child.publication && <Json value={child.publication} />}
                  </div>
                ))}
                <h3>Cross-repository verification</h3>
                <Json
                  value={detail.crossVerification ?? { status: "Pending" }}
                />
                {detail.publication && <Json value={detail.publication} />}
              </section>
            )}
            <div className="tabs">
              {[
                "Overview",
                "Diff",
                "Verification",
                "Review",
                "Events",
                "Artifacts",
              ].map((t) => (
                <button
                  className={tab === t ? "selected" : ""}
                  onClick={() => setTab(t)}
                  key={t}
                >
                  {t}
                </button>
              ))}
            </div>
            {tab === "Overview" && (
              <div className="columns">
                <section className="panel">
                  <h2>Phase timeline</h2>
                  {detail.phases.map((p: any) => (
                    <button
                      className={`phase ${phase === p.phase_id ? "active" : ""}`}
                      key={p.phase_id}
                      onClick={() => setPhase(p.phase_id)}
                    >
                      <span>
                        {p.status === "PASSED"
                          ? "✓"
                          : p.status === "RUNNING"
                            ? "●"
                            : "○"}
                      </span>
                      <div>
                        {p.phase_id}
                        <small>
                          {p.attempts} attempt{p.attempts === 1 ? "" : "s"}
                        </small>
                      </div>
                      <Badge status={p.status} />
                    </button>
                  ))}
                </section>
                <section className="panel">
                  <h2>{phase || "Run evidence"}</h2>
                  {phase ? (
                    <>
                      {events
                        .filter(
                          (e) =>
                            e.phase_id === phase ||
                            JSON.parse(e.payload_json).phaseId === phase,
                        )
                        .map((e) => (
                          <div className="event" key={e.sequence}>
                            <span>{e.type}</span>
                            <Json value={JSON.parse(e.payload_json)} />
                          </div>
                        ))}
                    </>
                  ) : (
                    <>
                      <p>
                        Select a phase to inspect its transitions. Artifacts
                        include context, agent output and independent command
                        evidence.
                      </p>
                      <Json
                        value={{
                          candidate: detail.candidate?.revision,
                          error: detail.error,
                        }}
                      />
                      {detail.approvals.map((a: any) => (
                        <button key={a.id} onClick={() => setPage("Approvals")}>
                          Review {a.status.toLowerCase()} approval
                        </button>
                      ))}
                    </>
                  )}
                </section>
              </div>
            )}
            {tab === "Diff" && (
              <section className="panel">
                <h2>Candidate diff</h2>
                <p className="muted">
                  {detail.candidate?.revision ?? "No candidate captured yet"}
                </p>
                <pre className="diff">
                  {detail.candidate?.diff ||
                    "Changes will appear after implementation."}
                </pre>
              </section>
            )}
            {tab === "Verification" && (
              <section className="panel">
                <h2>Independent verification</h2>
                {detail.verification?.results?.map((r: any) => (
                  <details key={r.id}>
                    <summary>
                      <Badge status={r.passed ? "PASSED" : "FAILED"} /> {r.id} ·
                      exit {r.exitCode}
                    </summary>
                    <Json value={r} />
                  </details>
                )) ?? <p>No verification recorded yet.</p>}
              </section>
            )}
            {tab === "Review" && (
              <section className="panel">
                <h2>Candidate review</h2>
                <Json
                  value={detail.review ?? { message: "Review has not run yet" }}
                />
                {detail.review?.findings.map((f: any) => (
                  <label className="checkbox" key={f.id}>
                    <input
                      type="checkbox"
                      checked={selectedFindings.includes(f.id)}
                      onChange={(e) =>
                        setSelectedFindings((ids) =>
                          e.target.checked
                            ? [...ids, f.id]
                            : ids.filter((id) => id !== f.id),
                        )
                      }
                    />
                    {f.path}:{f.line} — {f.message}
                  </label>
                ))}
                {detail.publication?.id && (
                  <button
                    disabled={!selectedFindings.length}
                    onClick={() =>
                      void act(async () => {
                        await api(`/runs/${detail.id}/comments`, {
                          findingIds: selectedFindings,
                        });
                        await refresh();
                        setPage("Approvals");
                      })
                    }
                  >
                    Propose selected PR comments
                  </button>
                )}
              </section>
            )}
            {tab === "Events" && (
              <section className="panel">
                <h2>
                  Live events <small>Last 1,000</small>
                </h2>
                {events.map((e) => (
                  <details key={e.sequence}>
                    <summary>
                      <code>{e.sequence}</code> {e.type}{" "}
                      <small>{e.phase_id}</small>
                    </summary>
                    <Json value={JSON.parse(e.payload_json)} />
                  </details>
                ))}
              </section>
            )}
            {tab === "Artifacts" && (
              <div className="columns">
                <section className="panel">
                  <h2>Artifacts</h2>
                  {detail.artifacts.map((a: any) => (
                    <button
                      className="artifact"
                      key={a.id}
                      onClick={() =>
                        void act(async () =>
                          setArtifact(
                            await api(`/runs/${detail.id}/artifacts/${a.id}`),
                          ),
                        )
                      }
                    >
                      {a.role}
                      <small>
                        {a.bytes.toLocaleString()} bytes · {a.hash.slice(0, 12)}
                      </small>
                    </button>
                  ))}
                </section>
                <section className="panel">
                  <h2>Artifact contents</h2>
                  <Json
                    value={
                      artifact ?? { message: "Choose an artifact to inspect" }
                    }
                  />
                </section>
              </div>
            )}
          </>
        )}
        {page === "Repositories" && (
          <div className="columns">
            <section className="panel">
              <h2>Registered repositories</h2>
              {repos.map((r) => (
                <button
                  key={r.id}
                  className="artifact"
                  onClick={() => setEditor(JSON.stringify(r, null, 2))}
                >
                  {r.name}
                  <small>{r.path}</small>
                  <span>{r.languages.join(" · ")}</span>
                </button>
              ))}
              <button
                className="secondary"
                onClick={() => setEditor(JSON.stringify(repoExample, null, 2))}
              >
                New profile
              </button>
            </section>
            <section className="panel">
              <h2>Repository profile</h2>
              <p>
                Configure trusted commands, installed Gemini arguments, workflow
                phases and skills. Changes apply to new runs.
              </p>
              <textarea
                className="editor"
                aria-label="Repository profile JSON"
                value={editor}
                onChange={(e) => setEditor(e.target.value)}
              />
              <button
                onClick={() =>
                  void act(async () => {
                    await api("/repositories", JSON.parse(editor));
                    await refresh();
                    setNotice("Repository profile saved.");
                  })
                }
              >
                Save profile
              </button>
            </section>
          </div>
        )}
        {page === "Workspaces" && (
          <div className="columns">
            <section className="panel">
              <h2>Workspace groups</h2>
              {workspaces.map((w) => (
                <button
                  className="artifact"
                  key={w.id}
                  onClick={() => setWorkspaceEditor(JSON.stringify(w, null, 2))}
                >
                  {w.name}
                  <small>
                    {w.repositories.map((r: any) => r.repositoryId).join(" · ")}
                  </small>
                </button>
              ))}
              <h3>Import VS Code workspace</h3>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void act(async () => {
                    const result = await api("/workspaces/import", {
                      id: importId,
                      path: importPath,
                    });
                    setWorkspaceEditor(
                      JSON.stringify(result.workspace, null, 2),
                    );
                    await refresh();
                    setNotice(result.note);
                  });
                }}
              >
                <label>
                  New workspace ID
                  <input
                    required
                    value={importId}
                    onChange={(e) => setImportId(e.target.value)}
                  />
                </label>
                <label>
                  Local .code-workspace path
                  <input
                    required
                    value={importPath}
                    onChange={(e) => setImportPath(e.target.value)}
                    placeholder="/workspaces/product.code-workspace"
                  />
                </label>
                <button>Import folders</button>
              </form>
              <p>
                Folder paths only. Tasks and settings are never imported or
                executed.
              </p>
            </section>
            <section className="panel">
              <h2>Workspace profile</h2>
              <p>
                List repositories in dependency order. Configure required
                integration checks using argument placeholders such as{" "}
                {"{workspace:service}"}. Changes apply to new runs.
              </p>
              <textarea
                className="editor"
                aria-label="Workspace profile JSON"
                value={workspaceEditor}
                onChange={(e) => setWorkspaceEditor(e.target.value)}
              />
              <button
                onClick={() =>
                  void act(async () => {
                    await api("/workspaces", JSON.parse(workspaceEditor));
                    await refresh();
                    setNotice("Workspace profile saved.");
                  })
                }
              >
                Save workspace
              </button>
            </section>
          </div>
        )}
        {page === "Approvals" && (
          <>
            {!approvals.length && (
              <section className="panel empty">
                No approvals requested yet.
              </section>
            )}
            {approvals.map((a) => (
              <section className="panel" key={a.id}>
                <div className="run-heading">
                  <h2>{a.subject.workspace ?? a.subject.repository}</h2>
                  <Badge status={a.status} />
                </div>
                <p>
                  {a.subject.type === "linked-publication" ? (
                    `${a.subject.candidates.length} candidates · one revision-bound approval · non-atomic publication`
                  ) : (
                    <>
                      Candidate <code>{a.subject.candidate}</code>
                    </>
                  )}
                </p>
                <p>Proposed effects: {a.subject.effects.join(", ")}</p>
                <button
                  className="link"
                  onClick={() => void act(() => openRun(a.run_id))}
                >
                  Inspect diff and verification →
                </button>
                <Json value={a.subject} />
                {a.status === "PENDING" && (
                  <div className="actions">
                    <button
                      className="danger"
                      onClick={() =>
                        void act(async () => {
                          await api(`/approvals/${a.id}`, {
                            subjectHash: a.subject_hash,
                            decision: "REJECTED",
                          });
                          await refresh();
                        })
                      }
                    >
                      Reject
                    </button>
                    <button
                      onClick={() =>
                        void act(async () => {
                          await api(`/approvals/${a.id}`, {
                            subjectHash: a.subject_hash,
                            decision: "APPROVED",
                          });
                          await refresh();
                        })
                      }
                    >
                      {a.subject.type === "linked-publication"
                        ? "Approve repository set"
                        : "Approve this candidate"}
                    </button>
                  </div>
                )}
              </section>
            ))}
          </>
        )}
        {page === "Approvals" &&
          approvals
            .filter(
              (a) =>
                a.status === "APPROVED" && a.subject.type === "review-comments",
            )
            .map((a) => (
              <section className="panel" key={`publish-${a.id}`}>
                <h2>Approved review comments</h2>
                <button
                  onClick={() =>
                    void act(async () => {
                      await api(`/approvals/${a.id}/publish`, {});
                      setNotice("Selected comments published or reconciled.");
                    })
                  }
                >
                  Publish approved comments
                </button>
              </section>
            ))}
        {page === "Graph" && (
          <>
            <section className="panel">
              <h2>External graph provider</h2>
              <p>
                Configure <code>graph</code> in the repository profile to
                connect Graphify or another tool. The harness does not build an
                index.
              </p>
              <form
                className="run-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void act(async () => {
                    setGraph(
                      await api("/graph", {
                        repositoryId: repo,
                        operation,
                        query,
                        nodeId: query,
                        limit: 100,
                      }),
                    );
                    setNode(undefined);
                  });
                }}
              >
                <label>
                  Repository
                  <select
                    value={repo}
                    onChange={(e) => setRepo(e.target.value)}
                  >
                    {repos.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Operation
                  <select
                    value={operation}
                    onChange={(e) => setOperation(e.target.value)}
                  >
                    {[
                      "search",
                      "neighbors",
                      "callers",
                      "callees",
                      "dependencies",
                      "dependents",
                      "tests",
                    ].map((o) => (
                      <option key={o}>{o}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Search / node ID
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </label>
                <button>Query provider</button>
              </form>
            </section>
            {graph && (
              <div className="columns">
                <section className="panel">
                  <h2>
                    {graph.provider}{" "}
                    <small>
                      {graph.complete ? "Complete result" : "Partial result"}
                    </small>
                  </h2>
                  {graph.nodes.map((n: any) => (
                    <button
                      className="artifact"
                      key={n.id}
                      onClick={() => setNode(n)}
                    >
                      {n.name}
                      <small>
                        {n.type} · {n.path}:{n.line}
                      </small>
                    </button>
                  ))}
                </section>
                <section className="panel">
                  <h2>Relationships and provenance</h2>
                  <Json
                    value={
                      node
                        ? {
                            node,
                            edges: graph.edges.filter(
                              (e: any) =>
                                e.source === node.id || e.target === node.id,
                            ),
                          }
                        : {
                            revision: graph.revision,
                            diagnostics: graph.diagnostics,
                          }
                    }
                  />
                </section>
              </div>
            )}
          </>
        )}
        {page === "Evals" && (
          <div className="columns">
            <section className="panel">
              <h2>Experiments</h2>
              <p>
                Run a suite with <code>eng eval run suite.json</code>. Every
                variant uses the same workflow engine.
              </p>
              {evals.map((e) => (
                <button
                  className="artifact"
                  key={e.id}
                  onClick={() =>
                    void act(async () =>
                      setEvaluation(await api(`/evals/${e.id}`)),
                    )
                  }
                >
                  {e.name}
                  <Badge status={e.status} />
                </button>
              ))}
            </section>
            <section className="panel">
              <h2>Comparison</h2>
              {evaluation ? (
                <>
                  <table>
                    <thead>
                      <tr>
                        <th>Variant</th>
                        <th>Solved</th>
                        <th>Mean attempts</th>
                        <th>Mean runtime</th>
                      </tr>
                    </thead>
                    <tbody>
                      {evaluation.variants.map((v: any) => (
                        <tr key={v.variant}>
                          <td>{v.variant}</td>
                          <td>
                            {v.solved}/{v.total}
                          </td>
                          <td>{v.meanAttempts.toFixed(1)}</td>
                          <td>{(v.meanDurationMs / 1000).toFixed(1)}s</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {evaluation.results.map((r: any) => (
                    <details key={r.id}>
                      <summary>
                        {r.case_id} / {r.variant} · {r.result.status}
                      </summary>
                      {r.run_id && (
                        <button
                          className="link"
                          onClick={() => void act(() => openRun(r.run_id))}
                        >
                          Inspect run
                        </button>
                      )}
                      <Json value={r.result} />
                    </details>
                  ))}
                </>
              ) : (
                <p>Select an experiment.</p>
              )}
            </section>
          </div>
        )}
        {page === "Settings" && (
          <section className="panel">
            <h2>Workstation readiness</h2>
            <p>
              Gemini uses the command already installed in your VS Code
              terminal. No Gemini Docker image is required.
            </p>
            <button
              onClick={() =>
                void act(async () => setSettings(await api("/doctor")))
              }
            >
              Run diagnostics
            </button>
            {settings && <Json value={settings} />}
            <hr />
            <h2>Integrations</h2>
            <p>
              Import trusted Jira, Confluence and Stash connection profiles with{" "}
              <code>eng integration add profile.json</code>. Credentials are
              environment references, never stored values.
            </p>
            <button
              className="secondary"
              onClick={() => {
                sessionStorage.removeItem("eng-token");
                token = "";
                setAuthenticated(false);
              }}
            >
              Disconnect session
            </button>
          </section>
        )}
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
