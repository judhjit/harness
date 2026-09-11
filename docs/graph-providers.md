# Pluggable graph providers

The harness does not build a code graph, choose a graph product or install an indexer.
Graph context is optional. Developers keep using Graphify or another tool and
connect it through a provider. No native Graphify API is assumed by this release.

Providers implement [GraphProvider](../packages/core/src/graph.ts). Each declares
its capabilities: search, neighbors, callers, callees, dependencies, dependents,
tests and/or impact. Unsupported operations return an explicit error. All responses
identify the indexed Git revision and provider version; stale results are rejected.

## Command adapter

Add this to a trusted repository profile:

```json
{
  "graph": {
    "id": "my-graphify-bridge",
    "type": "command",
    "executable": "/path/to/graph-wrapper",
    "args": [],
    "capabilities": ["search", "neighbors", "impact"],
    "timeoutMs": 30000
  }
}
```

The command receives one JSON request through stdin, with no shell interpolation:

```json
{
  "repository": "/path/to/repo",
  "revision": "exact-git-commit",
  "operation": "search",
  "query": "PaymentService",
  "limit": 100
}
```

Relationship operations pass `nodeId`; impact passes `files`. The wrapper adapts
your chosen tool's CLI, export or API into this response on stdout:

```json
{
  "schemaVersion": 1,
  "provider": "graphify",
  "providerVersion": "your-installed-version",
  "revision": "exact-git-commit",
  "nodes": [
    {"id": "payment", "name": "PaymentService", "type": "Class", "path": "src/PaymentService.java", "line": 12}
  ],
  "edges": [],
  "diagnostics": ["Dynamic calls are not resolved"],
  "complete": false
}
```

Every edge must reference nodes in the response and contain `source`, `target`
and `type`. IDs must be unique within a response. Include `provenance` on edges
when available. Emit diagnostic output on stderr and a nonzero exit code on failure.
Command responses are bounded, deadline-limited and validated before consumption.
This protocol is independent of Java, Node, Python or React repository languages.

## Snapshot adapter

For offline exports, use the same response format in a JSON file:

```json
{
  "graph": {
    "id": "team-export",
    "type": "snapshot",
    "path": "/path/to/export.json",
    "capabilities": ["search", "neighbors", "callers", "callees", "dependencies", "dependents", "tests", "impact"]
  }
}
```

The harness filters the supplied snapshot for search/relationships and bounded
impact traversal; it does not extract new facts from source. Snapshot imports are
capped at 2 MB. Calls use `CALLS`, dependencies use `IMPORTS` or `DEPENDS_ON`, and
test associations use `TESTS` from test to covered/associated symbol. Match these
names in the wrapper or declare only the capabilities your export supports.

## Context, UI and evals

`eng graph PaymentService --repo payments` queries the selected provider. The Graph
screen exposes supported data and source locations. Start a run with
`--graph-context` (or the UI checkbox) to request graph context. Provider errors
are recorded as explicit context fallback diagnostics; they never silently become
verified structural facts. The initial query uses the pinned base revision, so
no claim is made that it describes an uncommitted implementation.

Golden-task variants can set `graphContext`, override the `graph` provider profile,
or override skills. Context artifacts retain responses, diagnostics and configured
provider provenance for inspection. No-graph execution remains supported.
