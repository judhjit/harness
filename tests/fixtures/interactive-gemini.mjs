import { createInterface } from "node:readline";
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("fixture-gemini 1");
  process.exit(0);
}
if (
  !process.stdin.isTTY ||
  !process.stdout.isTTY ||
  !args.includes("--prompt-interactive") ||
  args.includes("--approval-mode") ||
  args.includes("--output-format")
)
  process.exit(3);
console.log("TTY_CONFIRMED");
const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: true,
});
rl.question("Approve fixture tool? [y/N] ", (answer) => {
  if (answer !== "y") process.exit(4);
  console.log('\n{"summary":"fixture result"}');
  rl.close();
});
