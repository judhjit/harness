import { Application } from "../../packages/adapters/src/application.ts";
const [root, id] = process.argv.slice(2);
const app = new Application(root);
const create = app.store.create.bind(app.store);
app.store.create = (config) => {
  const child = create(config);
  if (config.parentRunId) process.kill(process.pid, "SIGKILL");
  return child;
};
await app.execute(id);
app.close();
process.disconnect?.();
