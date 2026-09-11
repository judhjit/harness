export type GraphCapability =
  | "search"
  | "neighbors"
  | "callers"
  | "callees"
  | "dependencies"
  | "dependents"
  | "tests"
  | "impact";
export interface GraphNode {
  id: string;
  name: string;
  type: string;
  path?: string;
  line?: number;
}
export interface GraphEdge {
  source: string;
  target: string;
  type: string;
  provenance?: string;
}
export interface GraphRequest {
  repository: string;
  revision: string;
  operation: GraphCapability;
  query?: string;
  nodeId?: string;
  files?: string[];
  limit: number;
}
export interface GraphResult {
  schemaVersion: 1;
  provider: string;
  providerVersion: string;
  revision: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  diagnostics: string[];
  complete: boolean;
}
export interface GraphProvider {
  id: string;
  capabilities: readonly GraphCapability[];
  query(request: GraphRequest, signal?: AbortSignal): Promise<GraphResult>;
}
export interface GraphProviderConfig {
  id: string;
  type: "command" | "snapshot";
  capabilities: GraphCapability[];
  executable?: string;
  args?: string[];
  path?: string;
  timeoutMs?: number;
}
