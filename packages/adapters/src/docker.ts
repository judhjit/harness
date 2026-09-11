import { HarnessError } from "../../core/src/contracts.ts";
import { command } from "./commands.ts";
import { hash } from "./files.ts";

// Optional execution adapter. Image references resolve only from the local daemon;
// this adapter never installs or pulls images and never mounts its socket.
export class DockerBackend {
  executable: string;
  installation: string;
  constructor(root: string, executable = "docker") {
    this.executable = executable;
    this.installation = hash(root).slice(0, 12);
  }
  async inspect(name: string) {
    const r = await command(this.executable, ["inspect", name], {
      timeoutMs: 10000,
    });
    if (r.exitCode !== 0)
      throw new HarnessError(
        "INFRASTRUCTURE",
        "Docker inspection failed; do not infer resource absence",
      );
    return JSON.parse(r.stdout)[0];
  }
  async prepare(
    id: string,
    image: string,
    workspace: string,
    executable: string,
    args: string[],
    timeoutMs: number,
  ) {
    if (!/^[a-f0-9-]{36}$/.test(id) || workspace.includes(","))
      throw new HarnessError(
        "INPUT",
        "Invalid Docker execution identity or mount",
      );
    const imageResult = await command(
      this.executable,
      ["image", "inspect", image],
      { timeoutMs: 10000 },
    );
    if (imageResult.exitCode !== 0)
      throw new HarnessError(
        "INPUT",
        "Optional check image is not present locally; prepare it separately",
      );
    const digest = JSON.parse(imageResult.stdout)[0].Id;
    const name = `eng-${this.installation}-${id}`;
    const create = await command(
      this.executable,
      [
        "create",
        "--pull=never",
        "--name",
        name,
        "--label",
        `eng.installation=${this.installation}`,
        "--label",
        `eng.invocation=${id}`,
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        "128",
        "--memory",
        "1g",
        "--cpus",
        "2",
        "--network",
        "none",
        "--user",
        `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
        "--tmpfs",
        "/tmp:rw,nosuid,size=256m,mode=1777",
        "--mount",
        `type=bind,src=${workspace},dst=/workspace`,
        "--workdir",
        "/workspace",
        "--env",
        "HOME=/tmp",
        "--env",
        "CI=true",
        "--entrypoint",
        "/usr/bin/timeout",
        digest,
        String(Math.ceil(timeoutMs / 1000)),
        executable,
        ...args,
      ],
      { timeoutMs: 15000 },
    );
    if (create.exitCode !== 0)
      throw new HarnessError(
        "INFRASTRUCTURE",
        "Container creation failed or ambiguous; reconcile by invocation name",
      );
    return {
      name,
      image: digest,
      command: this.executable,
      args: ["start", "--attach", name],
    };
  }
  async stop(name: string) {
    const info = await this.inspect(name);
    if (info.Config?.Labels?.["eng.installation"] !== this.installation)
      throw new HarnessError(
        "POLICY",
        "Container is not owned by this harness",
      );
    if (info.State.Running) {
      const r = await command(this.executable, ["kill", name], {
        timeoutMs: 10000,
      });
      if (r.exitCode !== 0)
        throw new HarnessError("INFRASTRUCTURE", "Container stop failed");
    }
    return this.inspect(name);
  }
}
