import { Coordinator } from "../../packages/core/src/coordinator.ts";
import { SqliteStore } from "../../packages/adapters/src/sqlite.ts";
import { hash } from "../../packages/adapters/src/files.ts";
import { config, runtime } from "../helpers.ts";
const [root, mode] = process.argv.slice(2);
const store = new SqliteStore(root);
const c = await config(root);
c.workflow.phases[0].maxAttempts = 2;
const run = store.create(c);
process.send!({ runId: run.id });
await new Promise((resolve) => process.once("message", resolve));
if (mode === "artifact") {
  const put = store.put.bind(store);
  store.put = (...args) => {
    const result = put(...args);
    if (args[2] === "ticket") process.kill(process.pid, "SIGKILL");
    return result;
  };
}
if (mode === "phase") {
  const pass = store.pass.bind(store);
  store.pass = (...args) => {
    pass(...args);
    process.kill(process.pid, "SIGKILL");
  };
}
await new Coordinator(
  store,
  runtime(root, mode === "agent" ? "hang" : ""),
  hash,
).resume(run.id);
store.close();
process.disconnect?.();
