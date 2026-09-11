import { readFileSync, statSync } from "node:fs";
import { HarnessError } from "../../core/src/contracts.ts";
import type {
  GraphProvider,
  GraphProviderConfig,
  GraphRequest,
  GraphResult,
} from "../../core/src/graph.ts";
import { command } from "./commands.ts";

export function validateGraph(
  value: unknown,
  request: GraphRequest,
): GraphResult {
  const r = value as GraphResult;
  if (
    !r ||
    r.schemaVersion !== 1 ||
    typeof r.provider !== "string" ||
    typeof r.providerVersion !== "string" ||
    r.revision !== request.revision ||
    !Array.isArray(r.nodes) ||
    !Array.isArray(r.edges) ||
    !Array.isArray(r.diagnostics) ||
    r.diagnostics.some((d) => typeof d !== "string") ||
    typeof r.complete !== "boolean"
  )
    throw new HarnessError(
      "VALIDATION",
      "Invalid or stale graph-provider response",
    );
  if (r.nodes.length > request.limit || r.edges.length > request.limit * 10)
    throw new HarnessError(
      "VALIDATION",
      "Graph provider exceeded result limits",
    );
  const ids = new Set<string>();
  for (const n of r.nodes) {
    if (
      !n ||
      typeof n.id !== "string" ||
      typeof n.name !== "string" ||
      typeof n.type !== "string" ||
      ids.has(n.id)
    )
      throw new HarnessError("VALIDATION", "Invalid graph node");
    ids.add(n.id);
  }
  for (const e of r.edges)
    if (!ids.has(e.source) || !ids.has(e.target) || typeof e.type !== "string")
      throw new HarnessError(
        "VALIDATION",
        "Graph edge references missing nodes",
      );
  return r;
}
export class ExternalGraphProvider implements GraphProvider {
  config: GraphProviderConfig;
  id: string;
  capabilities: GraphProviderConfig["capabilities"];
  constructor(config: GraphProviderConfig) {
    this.config = config;
    this.id = config.id;
    this.capabilities = config.capabilities;
  }
  async query(
    request: GraphRequest,
    signal?: AbortSignal,
  ): Promise<GraphResult> {
    if (!this.capabilities.includes(request.operation))
      throw new HarnessError(
        "INPUT",
        `${this.id} does not support ${request.operation}`,
      );
    if (
      !Number.isInteger(request.limit) ||
      request.limit < 1 ||
      request.limit > 500
    )
      throw new HarnessError("INPUT", "Graph result limit must be 1–500");
    let value: unknown;
    if (this.config.type === "snapshot") {
      if (!this.config.path || statSync(this.config.path).size > 2_000_000)
        throw new HarnessError("INPUT", "Missing or oversized graph snapshot");
      const snapshot = validateGraph(
        JSON.parse(readFileSync(this.config.path, "utf8")),
        { ...request, limit: 10000 },
      );
      const ids = new Set<string>();
      const operation = request.operation;
      if (operation === "search") {
        for (const n of snapshot.nodes)
          if (
            n.name.toLowerCase().includes((request.query ?? "").toLowerCase())
          )
            ids.add(n.id);
      } else if (operation === "impact") {
        for (const n of snapshot.nodes)
          if (request.files?.includes(n.path ?? "")) ids.add(n.id);
        for (let depth = 0; depth < 3 && ids.size <= request.limit; depth++) {
          const before = new Set(ids);
          for (const e of snapshot.edges)
            if (
              before.has(e.target) &&
              ["IMPORTS", "DEPENDS_ON", "CALLS", "TESTS"].includes(e.type)
            )
              ids.add(e.source);
        }
      } else {
        if (!request.nodeId)
          throw new HarnessError(
            "INPUT",
            "nodeId is required for relationship queries",
          );
        ids.add(request.nodeId);
        const types =
          operation === "callers" || operation === "callees"
            ? ["CALLS"]
            : operation === "tests"
              ? ["TESTS"]
              : operation === "neighbors"
                ? null
                : ["IMPORTS", "DEPENDS_ON"];
        for (const e of snapshot.edges)
          if (!types || types.includes(e.type)) {
            if (
              e.source === request.nodeId &&
              ["neighbors", "callees", "dependencies"].includes(operation)
            )
              ids.add(e.target);
            if (
              e.target === request.nodeId &&
              ["neighbors", "callers", "dependents", "tests"].includes(
                operation,
              )
            )
              ids.add(e.source);
          }
      }
      const nodes = snapshot.nodes
        .filter((n) => ids.has(n.id))
        .slice(0, request.limit);
      const included = new Set(nodes.map((n) => n.id));
      value = {
        ...snapshot,
        nodes,
        edges: snapshot.edges
          .filter((e) => included.has(e.source) && included.has(e.target))
          .slice(0, request.limit * 10),
        complete: snapshot.complete && ids.size <= request.limit,
      };
    } else {
      if (!this.config.executable)
        throw new HarnessError("INPUT", "Graph command executable is required");
      const result = await command(
        this.config.executable,
        this.config.args ?? [],
        {
          input: JSON.stringify(request),
          timeoutMs: this.config.timeoutMs ?? 30000,
          signal,
          env: { PATH: process.env.PATH, HOME: process.env.HOME },
        },
      );
      if (result.exitCode !== 0 || result.timedOut)
        throw new HarnessError(
          "INFRASTRUCTURE",
          `Graph provider ${this.id} failed`,
        );
      value = JSON.parse(result.stdout);
    }
    return validateGraph(value, request);
  }
}
