import { randomUUID } from "node:crypto";
import { SqliteStore } from "./sqlite.ts";
import { hash } from "./files.ts";
import { HarnessError } from "../../core/src/contracts.ts";
import type { RepositoryProfile } from "../../core/src/product.ts";
import type { IntegrationConfig } from "./integrations.ts";

export class ProductStore {
  store: SqliteStore;
  constructor(store: SqliteStore) {
    this.store = store;
    store.db.exec(`
    CREATE TABLE IF NOT EXISTS repository_profiles(id TEXT PRIMARY KEY,profile_json TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS integration_profiles(id TEXT PRIMARY KEY,config_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS jobs(run_id TEXT PRIMARY KEY REFERENCES runs(id),status TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS run_data(run_id TEXT NOT NULL REFERENCES runs(id),key TEXT NOT NULL,value_json TEXT NOT NULL,PRIMARY KEY(run_id,key));
    CREATE TABLE IF NOT EXISTS approvals(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),subject_hash TEXT NOT NULL,subject_json TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,decided_at TEXT,actor TEXT,UNIQUE(run_id,subject_hash));
    CREATE TABLE IF NOT EXISTS external_actions(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),kind TEXT NOT NULL,status TEXT NOT NULL,request_json TEXT NOT NULL,response_json TEXT);
    CREATE TABLE IF NOT EXISTS eval_experiments(id TEXT PRIMARY KEY,name TEXT NOT NULL,config_json TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS eval_results(id TEXT PRIMARY KEY,experiment_id TEXT NOT NULL REFERENCES eval_experiments(id),case_id TEXT NOT NULL,variant TEXT NOT NULL,repetition INTEGER NOT NULL,run_id TEXT REFERENCES runs(id),result_json TEXT NOT NULL,UNIQUE(experiment_id,case_id,variant,repetition));
  `);
  }
  repositories(): RepositoryProfile[] {
    return this.store.db
      .prepare("SELECT profile_json FROM repository_profiles ORDER BY id")
      .all()
      .map((r: any) => JSON.parse(r.profile_json));
  }
  repository(id: string) {
    const p = this.repositories().find((p) => p.id === id);
    if (!p)
      throw new HarnessError("INPUT", `Unknown repository profile: ${id}`);
    return p;
  }
  saveRepository(profile: RepositoryProfile) {
    this.store.db
      .prepare(
        "INSERT INTO repository_profiles VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET profile_json=excluded.profile_json,updated_at=excluded.updated_at",
      )
      .run(profile.id, JSON.stringify(profile), new Date().toISOString());
  }
  integrations(): IntegrationConfig[] {
    return this.store.db
      .prepare("SELECT config_json FROM integration_profiles ORDER BY id")
      .all()
      .map((r: any) => JSON.parse(r.config_json));
  }
  saveIntegration(config: IntegrationConfig) {
    this.store.db
      .prepare(
        "INSERT INTO integration_profiles VALUES(?,?) ON CONFLICT(id) DO UPDATE SET config_json=excluded.config_json",
      )
      .run(config.id, JSON.stringify(config));
  }
  data<T = any>(runId: string, key: string): T | undefined {
    const row = this.store.db
      .prepare("SELECT value_json FROM run_data WHERE run_id=? AND key=?")
      .get(runId, key) as any;
    return row ? JSON.parse(row.value_json) : undefined;
  }
  set(runId: string, key: string, value: unknown) {
    this.store.db
      .prepare(
        "INSERT INTO run_data VALUES(?,?,?) ON CONFLICT(run_id,key) DO UPDATE SET value_json=excluded.value_json",
      )
      .run(runId, key, JSON.stringify(value));
  }
  enqueue(runId: string) {
    this.store.transaction(() => {
      this.store.db
        .prepare(
          "INSERT INTO jobs VALUES(?,'QUEUED',?) ON CONFLICT(run_id) DO UPDATE SET status='QUEUED'",
        )
        .run(runId, new Date().toISOString());
      this.store.append(runId, "RUN_QUEUED");
    });
  }
  listRuns() {
    return this.store.db
      .prepare(
        "SELECT id,display_id,status,updated_at,error,config_json FROM runs ORDER BY updated_at DESC LIMIT 200",
      )
      .all()
      .map((r: any) => {
        const c = JSON.parse(r.config_json);
        return {
          ...r,
          config_json: undefined,
          ticket: c.ticket.key,
          title: c.ticket.title,
          repository: c.product?.repositoryId ?? c.source.repository,
        };
      });
  }
  approvals() {
    return this.store.db
      .prepare("SELECT * FROM approvals ORDER BY created_at DESC")
      .all()
      .map((r: any) => ({ ...r, subject: JSON.parse(r.subject_json) }));
  }
  proposal(runId: string, subject: unknown) {
    const subjectHash = hash(JSON.stringify(subject));
    const existing = this.store.db
      .prepare("SELECT * FROM approvals WHERE run_id=? AND subject_hash=?")
      .get(runId, subjectHash) as any;
    if (existing) return existing;
    const id = randomUUID();
    this.store.transaction(() => {
      this.store.db
        .prepare(
          "UPDATE approvals SET status='INVALIDATED' WHERE run_id=? AND status IN ('PENDING','APPROVED')",
        )
        .run(runId);
      this.store.db
        .prepare(
          "INSERT INTO approvals(id,run_id,subject_hash,subject_json,status,created_at) VALUES(?,?,?,?,'PENDING',?)",
        )
        .run(
          id,
          runId,
          subjectHash,
          JSON.stringify(subject),
          new Date().toISOString(),
        );
      this.store.append(runId, "APPROVAL_REQUESTED", { id, subjectHash });
    });
    return this.store.db
      .prepare("SELECT * FROM approvals WHERE id=?")
      .get(id) as any;
  }
  decide(
    id: string,
    expectedHash: string,
    decision: "APPROVED" | "REJECTED",
    actor: string,
  ) {
    this.store.transaction(() => {
      const row = this.store.db
        .prepare("SELECT * FROM approvals WHERE id=?")
        .get(id) as any;
      if (!row || row.subject_hash !== expectedHash || row.status !== "PENDING")
        throw new HarnessError(
          "POLICY",
          "Approval is stale or already decided",
        );
      this.store.db
        .prepare(
          "UPDATE approvals SET status=?,decided_at=?,actor=? WHERE id=?",
        )
        .run(decision, new Date().toISOString(), actor, id);
      this.store.append(row.run_id, `APPROVAL_${decision}`, {
        id,
        subjectHash: expectedHash,
        actor,
      });
    });
  }
}
