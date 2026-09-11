# Agentic Engineering Harness

The product now includes configurable engineering workflows, Git worktrees,
independent verification/repair, review and approvals, a local React UI, external
graph providers, eval comparisons and publication adapters. It uses the existing
`gemini` command from your VS Code Server terminal. Docker is optional for checks.

Start with [the product guide](docs/product-guide.md) and
[pluggable graph providers](docs/graph-providers.md).

```sh
npm ci --ignore-scripts
npm run build:web
npm run eng -- doctor
npm run eng -- serve
```

The planning-slice notes below describe the original retained compatibility mode.

Architecture and initial implementation boundaries are documented in
[docs/architecture.md](docs/architecture.md).

The first slice is implemented: a local, durable planning workflow using Gemini
CLI, SQLite and immutable artifacts. It runs intake → requirements → implementation
plan. It does not yet modify target repositories, run their tests, or publish PRs.

Use Node **24.13.x**. Install the current product's pinned dependencies first. The
built-in SQLite API currently emits an experimental warning on this Node version.

```sh
node apps/cli/bin/eng.mjs --help
npm run typecheck
npm test
```

For static checking, first install the pinned development dependencies with
`npm ci --ignore-scripts` using your approved registry/cache. Tests themselves run
with Node's built-in test runner and require permission to inspect owned processes.

See [the setup and operation guide](docs/planning-slice.md) for runtime isolation,
ticket fixtures, run/resume commands, recovery behavior, and known limitations.
The [architecture review](docs/architecture-review.md) records the broader design.
