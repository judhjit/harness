import { TerminalGeminiRuntime } from "../../packages/adapters/src/terminal-runtime.ts";
import { Waiting } from "../../packages/core/src/contracts.ts";
import { fileURLToPath } from "node:url";
const [root, id, mode] = process.argv.slice(2);
const runtime = new TerminalGeminiRuntime(
  root,
  root,
  {
    executable: process.execPath,
    args: [fileURLToPath(new URL("./interactive-gemini.mjs", import.meta.url))],
    environmentNames: [],
  },
  true,
);
try {
  for await (const event of runtime.run(
    {
      invocationId: id,
      prompt: "Return JSON with summary; do not write a report file.",
      timeoutMs: mode === "timeout" ? 1000 : 15000,
    },
    new AbortController().signal,
  ))
    if (event.type === "COMPLETED")
      console.log("HARNESS_RESULT=" + event.payload.text);
} catch (error) {
  console.log(
    error instanceof Waiting
      ? "HANDOFF_WAITING"
      : `HANDOFF_ERROR=${String(error)}`,
  );
}
