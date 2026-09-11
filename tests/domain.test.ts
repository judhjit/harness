import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertRunTransition,
  validateReport,
} from "../packages/core/src/contracts.ts";
import type { RunStatus } from "../packages/core/src/contracts.ts";
import { config, fixtureRoot } from "./helpers.ts";

test("run state machine rejects terminal reopening and premature completion", () => {
  const statuses: RunStatus[] = [
    "CREATED",
    "RUNNING",
    "BLOCKED",
    "COMPLETED",
    "FAILED",
    "CANCELLED",
  ];
  for (const from of ["COMPLETED", "FAILED", "CANCELLED"] as RunStatus[])
    for (const to of statuses)
      assert.throws(() => assertRunTransition(from, to));
  assert.throws(() => assertRunTransition("CREATED", "COMPLETED"));
  assertRunTransition("CREATED", "RUNNING");
  assertRunTransition("BLOCKED", "RUNNING");
});

test("schema checks reject missing criteria, foreign source locations and wrong revision", async () => {
  const c = await config(fixtureRoot());
  const phase = c.workflow.phases[1];
  const valid = {
    schemaVersion: 1,
    ticketKey: c.ticket.key,
    baseRevision: c.source.revision,
    criteria: [
      { id: "AC1", description: "first" },
      { id: "AC2", description: "second" },
    ],
    relevantFiles: ["src/service.ts"],
  };
  validateReport(JSON.stringify(valid), phase, c);
  for (const invalid of [
    { ...valid, baseRevision: "wrong" },
    { ...valid, criteria: valid.criteria.slice(0, 1) },
    { ...valid, relevantFiles: ["unknown.ts"] },
  ])
    assert.throws(() => validateReport(JSON.stringify(invalid), phase, c));
});
