let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\n");
if (process.env.FIXTURE_MODE === "hang") {
  setInterval(() => {}, 1000);
} else {
  emit({ type: "init", session_id: "fixture-session", model: "fixture" });
  const bundle = JSON.parse(prompt.slice(prompt.indexOf('\n{"version":') + 1));
  const ticket = bundle.items[0].content;
  const base = {
    schemaVersion: 1,
    ticketKey: ticket.key,
    baseRevision: bundle.baseRevision,
  };
  let report = prompt.startsWith("# Requirements")
    ? {
        ...base,
        criteria: ticket.acceptanceCriteria.map((description, i) => ({
          id: `AC${i + 1}`,
          description,
        })),
        relevantFiles: bundle.items
          .filter((i) => i.source === "repo")
          .map((i) => i.uri.slice(i.uri.indexOf(":") + 1)),
      }
    : {
        ...base,
        steps: ticket.acceptanceCriteria.map((description, i) => ({
          description,
          criterionIds: [`AC${i + 1}`],
        })),
        verification: ["Run the repository test suite"],
      };
  if (process.env.FIXTURE_MODE === "claim") report = { testsPassed: true };
  if (process.env.FIXTURE_MODE === "bad-json")
    process.stdout.write("not-json\n");
  if (process.env.FIXTURE_MODE === "tool")
    emit({ type: "tool_use", tool_name: "run_shell_command" });
  const text = JSON.stringify(report);
  emit({
    type: "message",
    role: "assistant",
    content: text.slice(0, 20),
    delta: true,
  });
  emit({
    type: "message",
    role: "assistant",
    content: text.slice(20),
    delta: true,
  });
  if (process.env.FIXTURE_MODE !== "no-result")
    emit({ type: "result", status: "success", stats: { fixture: true } });
  process.exitCode = process.env.FIXTURE_MODE === "exit-error" ? 1 : 0;
}
