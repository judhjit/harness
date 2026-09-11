import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DockerBackend } from "../packages/adapters/src/docker.ts";
import { command } from "../packages/adapters/src/commands.ts";
import { fixtureRoot } from "./helpers.ts";

test(
  "optional Docker backend uses a local image and reconciles exact owned container",
  { skip: !process.env.ENG_DOCKER_TEST, timeout: 30000 },
  async () => {
    const root = fixtureRoot();
    const backend = new DockerBackend(root);
    const id = randomUUID();
    let name: string | undefined;
    try {
      const launch = await backend.prepare(
        id,
        process.env.ENG_DOCKER_TEST!,
        root,
        "node",
        ["-e", 'console.log("docker-check-ok")'],
        5000,
      );
      name = launch.name;
      const result = await command(launch.command, launch.args, {
        timeoutMs: 10000,
      });
      assert.equal(result.exitCode, 0, result.stderr);
      assert.match(result.stdout, /docker-check-ok/);
      const info = await backend.stop(name);
      assert.equal(info.State.ExitCode, 0);
      assert.equal(info.HostConfig.Privileged, false);
      assert.equal(info.HostConfig.ReadonlyRootfs, true);
      assert.equal(info.HostConfig.NetworkMode, "none");
      assert.equal(
        info.HostConfig.Binds?.some((b: string) => b.includes("docker.sock")) ??
          false,
        false,
      );
    } finally {
      if (name) {
        const info = await backend.inspect(name);
        if (info.Config.Labels["eng.invocation"] === id)
          await command("docker", ["rm", name]);
      }
    }
  },
);
