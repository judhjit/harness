import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { assertRunTransition, HarnessError } from "../../core/src/contracts.ts";
import type {
  Artifact,
  Attempt,
  Event,
  Phase,
  PhaseStatus,
  Run,
  RunConfig,
  RunStatus,
  Store,
} from "../../core/src/contracts.ts";
import {
  atomicWrite,
  encode,
  hash,
  privateDirectory,
  processIdentity,
  redact,
  safeRead,
  sanitize,
} from "./files.ts";

const schema = `
CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY);
INSERT OR IGNORE INTO schema_migrations VALUES (1);
CREATE TABLE IF NOT EXISTS runs (
 id TEXT PRIMARY KEY, display_id TEXT UNIQUE NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('CREATED','RUNNING','BLOCKED','COMPLETED','FAILED','CANCELLED')),
 config_json TEXT NOT NULL, config_hash TEXT NOT NULL, cancel_requested INTEGER NOT NULL DEFAULT 0,
 owner TEXT, owner_pid INTEGER, owner_identity TEXT, generation INTEGER NOT NULL DEFAULT 0,
 updated_at TEXT NOT NULL, error TEXT
);
CREATE TABLE IF NOT EXISTS phases (
 run_id TEXT NOT NULL REFERENCES runs(id), phase_id TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('PENDING','READY','RUNNING','PASSED','FAILED','BLOCKED','CANCELLED')),
 attempts INTEGER NOT NULL DEFAULT 0, selected_artifact TEXT,
 PRIMARY KEY(run_id,phase_id),
 FOREIGN KEY(run_id,selected_artifact) REFERENCES artifacts(run_id,id)
);
CREATE TABLE IF NOT EXISTS attempts (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL, phase_id TEXT NOT NULL, number INTEGER NOT NULL CHECK(number>0),
 status TEXT NOT NULL CHECK(status IN ('PREPARING','RUNNING','SUCCEEDED','FAILED','INTERRUPTED','CANCELLED')),
 deadline TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, failure_class TEXT, error TEXT,
 UNIQUE(run_id,id), UNIQUE(run_id,phase_id,number),
 FOREIGN KEY(run_id,phase_id) REFERENCES phases(run_id,phase_id)
);
CREATE TABLE IF NOT EXISTS artifacts (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), attempt_id TEXT,
 role TEXT NOT NULL, hash TEXT NOT NULL, bytes INTEGER NOT NULL CHECK(bytes>=0),
 UNIQUE(run_id,id), FOREIGN KEY(run_id,attempt_id) REFERENCES attempts(run_id,id)
);
CREATE TABLE IF NOT EXISTS events (
 run_id TEXT NOT NULL REFERENCES runs(id), sequence INTEGER NOT NULL, type TEXT NOT NULL,
 phase_id TEXT, attempt_id TEXT, timestamp TEXT NOT NULL, payload_json TEXT NOT NULL,
 PRIMARY KEY(run_id,sequence), FOREIGN KEY(run_id,attempt_id) REFERENCES attempts(run_id,id)
);
CREATE INDEX IF NOT EXISTS runs_status ON runs(status,updated_at);
CREATE INDEX IF NOT EXISTS artifact_run ON artifacts(run_id,role);
`;

export class SqliteStore implements Store {
  db: DatabaseSync;
  root: string;
  owner = randomUUID();
  generation = new Map<string, number>();
  constructor(root: string) {
    this.root = privateDirectory(root);
    privateDirectory(join(root, "blobs"));
    privateDirectory(join(root, "invocations"));
    for (const name of [
      "harness.sqlite",
      "harness.sqlite-wal",
      "harness.sqlite-shm",
    ]) {
      if (
        existsSync(join(root, name)) &&
        lstatSync(join(root, name)).isSymbolicLink()
      )
        throw new HarnessError(
          "POLICY",
          "Database files must not be symbolic links",
        );
    }
    this.db = new DatabaseSync(join(root, "harness.sqlite"));
    this.db.exec(
      "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;",
    );
    this.db.exec(schema);
    this.migrate();
  }
  migrate() {
    if (
      this.db
        .prepare("SELECT version FROM schema_migrations WHERE version=2")
        .get()
    )
      return;
    this.db.exec("PRAGMA foreign_keys=OFF");
    try {
      this.transaction(() => {
        for (const table of ["runs", "phases"]) {
          const sql = (
            this.db
              .prepare(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
              )
              .get(table) as any
          ).sql as string;
          this.db.exec(
            sql
              .replace(`CREATE TABLE ${table}`, `CREATE TABLE ${table}_v2`)
              .replace("'CANCELLED'))", "'CANCELLED','WAITING','SKIPPED'))"),
          );
          this.db.exec(
            `INSERT INTO ${table}_v2 SELECT * FROM ${table}; DROP TABLE ${table}; ALTER TABLE ${table}_v2 RENAME TO ${table};`,
          );
        }
        this.db.exec(
          "INSERT INTO schema_migrations VALUES(2); CREATE INDEX runs_status ON runs(status,updated_at);",
        );
      });
    } finally {
      this.db.exec("PRAGMA foreign_keys=ON");
    }
    if (this.db.prepare("PRAGMA foreign_key_check").all().length)
      throw new HarnessError(
        "INFRASTRUCTURE",
        "Migration foreign-key check failed",
      );
  }
  close() {
    this.db.close();
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  get(id: string): Run {
    const run = this.db
      .prepare("SELECT * FROM runs WHERE id=? OR display_id=?")
      .get(id, id) as unknown as Run;
    if (!run) throw new HarnessError("INPUT", `Unknown run: ${id}`);
    return run;
  }
  create(config: RunConfig): Run {
    const id = randomUUID();
    this.transaction(() => {
      const count =
        (this.db.prepare("SELECT COUNT(*) AS n FROM runs").get() as any).n + 1;
      const name = `ENG-${new Date().getUTCFullYear()}-${String(count).padStart(6, "0")}`;
      this.db
        .prepare(
          "INSERT INTO runs(id,display_id,status,config_json,config_hash,updated_at) VALUES(?,?,?,?,?,?)",
        )
        .run(
          id,
          name,
          "CREATED",
          encode(config),
          hash(encode(config)),
          new Date().toISOString(),
        );
      for (const phase of config.workflow.phases)
        this.db
          .prepare("INSERT INTO phases(run_id,phase_id,status) VALUES(?,?,?)")
          .run(id, phase.id, "PENDING");
      this.append(id, "RUN_CREATED", {
        displayId: name,
        workflow: config.workflow.id,
      });
    });
    return this.get(id);
  }
  phases(id: string) {
    return this.db
      .prepare(
        "SELECT phase_id,status,attempts FROM phases WHERE run_id=? ORDER BY rowid",
      )
      .all(id) as unknown as {
      phase_id: string;
      status: PhaseStatus;
      attempts: number;
    }[];
  }
  events(id: string, after = 0) {
    return this.db
      .prepare(
        "SELECT * FROM events WHERE run_id=? AND sequence>? ORDER BY sequence",
      )
      .all(id, after) as unknown as Event[];
  }
  artifacts(id: string) {
    return this.db
      .prepare("SELECT * FROM artifacts WHERE run_id=?")
      .all(id) as unknown as Artifact[];
  }
  append(id: string, type: string, payload: unknown = {}, attempt?: Attempt) {
    const encoded = encode(sanitize(payload));
    const bounded =
      Buffer.byteLength(encoded) > 16000
        ? encode({
            truncated: true,
            originalBytes: Buffer.byteLength(encoded),
            preview: encoded.slice(0, 8000),
            note: "Full sanitized runtime output is retained in invocation evidence",
          })
        : encoded;
    this.db
      .prepare(
        `INSERT INTO events VALUES (?,(SELECT COALESCE(MAX(sequence),0)+1 FROM events WHERE run_id=?),?,?,?,?,?)`,
      )
      .run(
        id,
        id,
        type,
        attempt?.phase_id ?? null,
        attempt?.id ?? null,
        new Date().toISOString(),
        bounded,
      );
  }
  assertOwner(id: string) {
    const run = this.get(id);
    if (run.owner !== this.owner || run.generation !== this.generation.get(id))
      throw new HarnessError("INFRASTRUCTURE", "Run ownership lost");
  }
  emit(id: string, type: string, payload: unknown = {}, attempt?: Attempt) {
    this.transaction(() => {
      this.assertOwner(id);
      this.append(id, type, payload, attempt);
    });
  }
  async acquire(id: string) {
    const identity = processIdentity(process.pid);
    this.transaction(() => {
      const run = this.get(id);
      if (
        run.owner &&
        run.owner_pid &&
        processIdentity(run.owner_pid) === run.owner_identity
      )
        throw new HarnessError(
          "INFRASTRUCTURE",
          "Run already has a live coordinator",
        );
      this.db
        .prepare(
          "UPDATE runs SET owner=?,owner_pid=?,owner_identity=?,generation=generation+1 WHERE id=?",
        )
        .run(this.owner, process.pid, identity, id);
      this.generation.set(id, run.generation + 1);
      this.append(id, "RUN_OWNERSHIP_ACQUIRED", {
        generation: run.generation + 1,
      });
    });
  }
  release(id: string) {
    this.db
      .prepare(
        "UPDATE runs SET owner=NULL,owner_pid=NULL,owner_identity=NULL WHERE id=? AND owner=? AND generation=?",
      )
      .run(id, this.owner, this.generation.get(id) ?? -1);
    this.generation.delete(id);
  }
  recover(id: string) {
    this.assertOwner(id);
    const attempts = this.db
      .prepare("SELECT * FROM attempts WHERE run_id=?")
      .all(id) as unknown as Attempt[];
    for (const attempt of attempts) {
      if (
        this.phases(id).find((p) => p.phase_id === attempt.phase_id)?.status ===
        "WAITING"
      )
        continue;
      const invocation = join(this.root, "invocations", attempt.id);
      if (existsSync(join(invocation, "intent.json"))) {
        const done = existsSync(join(invocation, "exit.json"));
        if (!done) {
          const marker = join(invocation, "process.json");
          if (!existsSync(marker))
            throw new HarnessError(
              "INFRASTRUCTURE",
              "Ambiguous process launch; invocation needs operator reconciliation",
            );
          const p = JSON.parse(safeRead(marker));
          if (processIdentity(p.pid) === p.identity)
            throw new HarnessError(
              "INFRASTRUCTURE",
              "Previous invocation is still stopping; retry resume shortly",
            );
          // An unobserved descendant could remain after a supervisor crash.
          if (existsSync(join(invocation, "child.json"))) {
            const child = JSON.parse(safeRead(join(invocation, "child.json")));
            try {
              process.kill(-child.pid, 0);
              throw new HarnessError(
                "INFRASTRUCTURE",
                "Orphan invocation group remains; operator reconciliation required",
              );
            } catch (error: any) {
              if (error.code !== "ESRCH") throw error;
            }
          } else if (existsSync(join(invocation, "launch.json"))) {
            throw new HarnessError(
              "INFRASTRUCTURE",
              "Child launch outcome unknown; operator reconciliation required",
            );
          }
        }
      }
      if (!["PREPARING", "RUNNING"].includes(attempt.status)) continue;
      this.transaction(() => {
        this.assertOwner(id);
        this.db
          .prepare(
            "UPDATE attempts SET status='INTERRUPTED',ended_at=? WHERE id=?",
          )
          .run(new Date().toISOString(), attempt.id);
        this.db
          .prepare(
            "UPDATE phases SET status='READY' WHERE run_id=? AND phase_id=?",
          )
          .run(id, attempt.phase_id);
        this.append(
          id,
          "ATTEMPT_INTERRUPTED",
          {
            reason:
              "No transactionally selected output; retry consumes existing budget",
          },
          attempt,
        );
      });
    }
  }
  put(
    id: string,
    attempt: string | null,
    role: string,
    value: unknown,
  ): Artifact {
    this.assertOwner(id);
    const content = encode(sanitize(value));
    const digest = hash(content);
    const path = join(this.root, "blobs", digest);
    if (!existsSync(path)) atomicWrite(path, content);
    if (hash(safeRead(path)) !== digest)
      throw new HarnessError("INFRASTRUCTURE", "Artifact hash mismatch");
    const a = {
      id: randomUUID(),
      run_id: id,
      attempt_id: attempt,
      role,
      hash: digest,
      bytes: Buffer.byteLength(content),
    };
    this.transaction(() => {
      this.assertOwner(id);
      this.db
        .prepare("INSERT INTO artifacts VALUES(?,?,?,?,?,?)")
        .run(a.id, id, attempt, role, digest, a.bytes);
      this.append(id, "ARTIFACT_CREATED", {
        artifactId: a.id,
        role,
        hash: digest,
      });
    });
    return a;
  }
  read(a: Artifact) {
    if (!/^[a-f0-9]{64}$/.test(a.hash))
      throw new HarnessError("INFRASTRUCTURE", "Invalid artifact digest");
    let value: string;
    try {
      value = safeRead(join(this.root, "blobs", a.hash));
    } catch {
      throw new HarnessError("INFRASTRUCTURE", `Missing artifact: ${a.id}`);
    }
    if (hash(value) !== a.hash || Buffer.byteLength(value) !== a.bytes)
      throw new HarnessError("INFRASTRUCTURE", `Corrupt artifact: ${a.id}`);
    return value;
  }
  selected(id: string, role: string) {
    const a = this.db
      .prepare(
        "SELECT a.* FROM artifacts a JOIN phases p ON p.run_id=a.run_id AND p.selected_artifact=a.id WHERE a.run_id=? AND a.role=? AND p.status='PASSED'",
      )
      .get(id, role) as unknown as Artifact;
    if (!a)
      throw new HarnessError(
        "INFRASTRUCTURE",
        `Missing passed output: ${role}`,
      );
    return a;
  }
  verify(id: string) {
    const run = this.get(id);
    if (hash(run.config_json) !== run.config_hash)
      throw new HarnessError(
        "INFRASTRUCTURE",
        "Run configuration hash mismatch",
      );
    for (const artifact of this.artifacts(id)) this.read(artifact);
  }
  start(id: string, phase: Phase): Attempt {
    return this.transaction(() => {
      this.assertOwner(id);
      const current = this.phases(id).find((p) => p.phase_id === phase.id)!;
      if (current.status === "WAITING") {
        const existing = this.db
          .prepare(
            "SELECT * FROM attempts WHERE run_id=? AND phase_id=? ORDER BY number DESC LIMIT 1",
          )
          .get(id, phase.id) as unknown as Attempt;
        this.db
          .prepare("UPDATE attempts SET status='RUNNING' WHERE id=?")
          .run(existing.id);
        this.db
          .prepare(
            "UPDATE phases SET status='RUNNING' WHERE run_id=? AND phase_id=?",
          )
          .run(id, phase.id);
        return existing;
      }
      if (
        !["PENDING", "READY", "BLOCKED"].includes(current.status) ||
        current.attempts >= phase.maxAttempts
      )
        throw new HarnessError(
          "AGENT",
          `Phase ${phase.id} exhausted its attempt budget`,
        );
      if (
        phase.dependsOn.some(
          (dep) =>
            !this.phases(id).some(
              (p) => p.phase_id === dep && p.status === "PASSED",
            ),
        )
      )
        throw new HarnessError(
          "INFRASTRUCTURE",
          "Unsatisfied phase dependency",
        );
      const a: Attempt = {
        id: randomUUID(),
        run_id: id,
        phase_id: phase.id,
        number: current.attempts + 1,
        status: "RUNNING",
        deadline: new Date(Date.now() + phase.timeoutMs).toISOString(),
      };
      this.append(id, "PHASE_READY", { phaseId: phase.id });
      this.db
        .prepare(
          "INSERT INTO attempts(id,run_id,phase_id,number,status,deadline,started_at) VALUES(?,?,?,?,?,?,?)",
        )
        .run(
          a.id,
          id,
          a.phase_id,
          a.number,
          a.status,
          a.deadline,
          new Date().toISOString(),
        );
      this.db
        .prepare(
          "UPDATE phases SET status='RUNNING',attempts=? WHERE run_id=? AND phase_id=?",
        )
        .run(a.number, id, phase.id);
      this.append(id, "PHASE_STARTED", { number: a.number }, a);
      return a;
    });
  }
  pass(a: Attempt, artifact: Artifact) {
    this.read(artifact);
    this.transaction(() => {
      this.assertOwner(a.run_id);
      if (this.get(a.run_id).cancel_requested)
        throw new HarnessError("CANCELLED", "Cancellation requested");
      if (artifact.run_id !== a.run_id || artifact.attempt_id !== a.id)
        throw new HarnessError("INFRASTRUCTURE", "Output ownership mismatch");
      const changed = this.db
        .prepare(
          "UPDATE attempts SET status='SUCCEEDED',ended_at=? WHERE id=? AND status='RUNNING'",
        )
        .run(new Date().toISOString(), a.id);
      if (changed.changes !== 1)
        throw new HarnessError("INFRASTRUCTURE", "Attempt is not running");
      this.db
        .prepare(
          "UPDATE phases SET status='PASSED',selected_artifact=? WHERE run_id=? AND phase_id=?",
        )
        .run(artifact.id, a.run_id, a.phase_id);
      this.append(
        a.run_id,
        "VALIDATION_COMPLETED",
        {
          status: "PASS",
          checks: ["executor_contract", "artifact_hash"],
          artifactId: artifact.id,
        },
        a,
      );
      this.append(a.run_id, "PHASE_PASSED", {}, a);
    });
  }
  fail(a: Attempt, error: HarnessError, retry: boolean) {
    this.transaction(() => {
      this.assertOwner(a.run_id);
      this.db
        .prepare(
          "UPDATE attempts SET status=?,ended_at=?,failure_class=?,error=? WHERE id=?",
        )
        .run(
          error.category === "CANCELLED" ? "CANCELLED" : "FAILED",
          new Date().toISOString(),
          error.category,
          redact(error.message),
          a.id,
        );
      this.db
        .prepare("UPDATE phases SET status=? WHERE run_id=? AND phase_id=?")
        .run(
          retry
            ? "READY"
            : error.category === "CANCELLED"
              ? "CANCELLED"
              : ["POLICY", "INFRASTRUCTURE"].includes(error.category)
                ? "BLOCKED"
                : "FAILED",
          a.run_id,
          a.phase_id,
        );
      this.append(
        a.run_id,
        retry ? "PHASE_RETRY_SCHEDULED" : "PHASE_FAILED",
        { category: error.category, message: error.message },
        a,
      );
    });
  }
  state(id: string, status: RunStatus, error?: string) {
    this.transaction(() => {
      this.assertOwner(id);
      assertRunTransition(this.get(id).status, status);
      if (
        status === "COMPLETED" &&
        (this.get(id).cancel_requested ||
          this.phases(id).some(
            (p) => !["PASSED", "SKIPPED"].includes(p.status),
          ))
      )
        throw new HarnessError(
          "INFRASTRUCTURE",
          "Cannot complete a cancelled or unverified run",
        );
      this.db
        .prepare("UPDATE runs SET status=?,updated_at=?,error=? WHERE id=?")
        .run(
          status,
          new Date().toISOString(),
          error ? redact(error) : null,
          id,
        );
      if (status === "CANCELLED")
        this.db
          .prepare(
            "UPDATE phases SET status='CANCELLED' WHERE run_id=? AND status NOT IN ('PASSED','FAILED')",
          )
          .run(id);
      this.append(id, `RUN_${status}`, { error });
    });
  }
  requestCancel(id: string) {
    this.transaction(() => {
      const run = this.get(id);
      if (["COMPLETED", "FAILED", "CANCELLED"].includes(run.status)) return;
      this.db.prepare("UPDATE runs SET cancel_requested=1 WHERE id=?").run(id);
      this.append(id, "RUN_CANCELLATION_REQUESTED");
    });
  }
  wait(a: Attempt) {
    this.transaction(() => {
      this.assertOwner(a.run_id);
      this.db
        .prepare("UPDATE attempts SET status='PREPARING' WHERE id=?")
        .run(a.id);
      this.db
        .prepare(
          "UPDATE phases SET status='WAITING' WHERE run_id=? AND phase_id=?",
        )
        .run(a.run_id, a.phase_id);
      this.append(a.run_id, "PHASE_WAITING", {}, a);
    });
  }
  skip(id: string, phase: Phase) {
    this.transaction(() => {
      this.assertOwner(id);
      this.db
        .prepare(
          "UPDATE phases SET status='SKIPPED' WHERE run_id=? AND phase_id=?",
        )
        .run(id, phase.id);
      this.append(id, "PHASE_SKIPPED", { phaseId: phase.id });
    });
  }
}
