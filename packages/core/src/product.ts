import type { Workflow } from "./contracts.ts";
import type { GraphProviderConfig } from "./graph.ts";
export interface CommandProfile {
  id: string;
  executable: string;
  args: string[];
  timeoutMs: number;
  required: boolean;
  report?: string;
  minTests?: number;
  dockerImage?: string;
}
export interface RepositoryProfile {
  id: string;
  name: string;
  path: string;
  base: string;
  languages: ("java" | "node" | "python" | "react")[];
  allowedPaths: string[];
  forbiddenPaths: string[];
  checks: CommandProfile[];
  runtime: {
    executable: string;
    args: string[];
    environmentNames: string[];
    mode: "workstation" | "docker";
    image?: string;
  };
  workflow?: Workflow;
  skills: Record<string, string>;
  integrations?: {
    jira?: string;
    confluence?: string;
    stash?: string;
    project?: string;
    slug?: string;
  };
  repairAttempts: number;
  graph?: GraphProviderConfig;
  contextPages?: string[];
}
export interface Candidate {
  revision: string;
  base: string;
  tree: string;
  diff: string;
  files: string[];
  workspace: string;
}
export interface CheckResult {
  id: string;
  passed: boolean;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  startedAt: string;
  endedAt: string;
  command: CommandProfile;
  candidate: string;
  tests?: number;
}
export interface Finding {
  id: string;
  severity: "blocking" | "warning" | "info";
  path: string;
  line: number;
  message: string;
  criterionIds?: string[];
}
export const referenceWorkflow: Workflow = {
  id: "engineering",
  version: "1",
  phases: [
    ["intake", "deterministic", "intake", "ticket"],
    ["investigate", "agent", "investigate", "investigation"],
    ["requirements", "agent", "requirements", "requirements"],
    ["plan", "agent", "plan", "plan"],
    ["implement", "agent", "implement", "implementation"],
    ["verify", "deterministic", "verify", "verification"],
    ["review", "agent", "review", "review"],
    ["approval", "human", "approval", "approval"],
    ["publish", "deterministic", "publish", "publication"],
  ].map(([id, executor, provider, output], i, rows) => ({
    id,
    executor: executor as "agent" | "deterministic" | "human",
    provider,
    output,
    dependsOn: i ? [rows[i - 1][0]] : [],
    maxAttempts: 2,
    timeoutMs: 1_800_000,
  })),
};
export const defaultSkills: Record<string, string> = {
  investigate:
    "Investigate the repository and ticket. Do not modify source. Return JSON {summary:string, relevantFiles:string[]}.",
  requirements:
    'Analyze the ticket. Do not modify source. Return JSON {criteria:[{id:"AC1",description:string}], uncertainties:string[]}.',
  plan: "Propose implementation steps and verification. Do not modify source. Return JSON {steps:[{description:string,criterionIds:string[]}], verification:string[]}.",
  implement:
    "Implement the accepted plan in this workspace. Do not publish, push, change Git metadata, or change harness policies. Return JSON {summary:string, changedFiles:string[]}.",
  repair:
    "Fix the supplied independent verification failures. Do not publish or change Git metadata. Return JSON {summary:string, changedFiles:string[]}.",
  review:
    'Review the candidate diff against requirements. Do not modify source. Return JSON {summary:string, criteria:[{id:string,status:"PASS"|"PARTIAL"|"FAIL",evidence:string}], findings:[{id:string,severity:"blocking"|"warning"|"info",path:string,line:number,message:string}]}. Treat requirement coverage as a judgment, not proof.',
};
