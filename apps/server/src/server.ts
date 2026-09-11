import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Application } from "../../../packages/adapters/src/application.ts";
import { Evaluations } from "../../../packages/adapters/src/evals.ts";
import {
  atomicWrite,
  safeRead,
  sanitize,
} from "../../../packages/adapters/src/files.ts";
import { InternalClient } from "../../../packages/adapters/src/integrations.ts";

async function body(req: IncomingMessage) {
  let text = "";
  for await (const chunk of req) {
    text += chunk;
    if (Buffer.byteLength(text) > 500_000)
      throw new Error("Request exceeds 500 KB");
  }
  return text ? JSON.parse(text) : {};
}
export function createApi(
  app: Application,
  token: string,
  allowedOrigins: string[] = [],
) {
  const evaluation = new Evaluations(app);
  return createServer(async (req, res) => {
    const send = (code: number, value: unknown) => {
      res.writeHead(code, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(JSON.stringify(sanitize(value)));
    };
    try {
      const host = req.headers.host ?? "";
      const allowedHosts = new Set([
        "127.0.0.1",
        "localhost",
        ...allowedOrigins.map((o) => new URL(o).hostname),
      ]);
      if (!allowedHosts.has(host.split(":")[0]))
        return send(403, {
          error: "Host not allowed; configure the forwarded origin",
        });
      const url = new URL(req.url ?? "/", `http://${host}`);
      const path = url.pathname;
      if (path.startsWith("/api/")) {
        if (
          req.headers.origin &&
          ![`http://${host}`, `https://${host}`, ...allowedOrigins].includes(
            req.headers.origin,
          )
        )
          return send(403, { error: "Origin not allowed" });
        const supplied = Buffer.from(
          req.headers.authorization?.replace(/^Bearer /, "") ?? "",
        );
        const expected = Buffer.from(token);
        if (
          supplied.length !== expected.length ||
          !timingSafeEqual(supplied, expected)
        )
          return send(401, {
            error: "Enter the local session token shown in the terminal",
          });
        const parts = path.split("/").filter(Boolean);
        const method = req.method ?? "GET";
        if (path === "/api/v1/runs" && method === "GET")
          return send(200, app.data.listRuns());
        if (path === "/api/v1/runs" && method === "POST") {
          const input = await body(req);
          if (input.workspaceId && input.repositoryId)
            throw new Error("Choose repositoryId or workspaceId, not both");
          return send(
            201,
            input.workspaceId
              ? app.multi.create(
                  input.workspaceId,
                  input.ticket,
                  !!input.graphContext,
                )
              : await app.create(
                  input.repositoryId,
                  input.ticket,
                  !!input.graphContext,
                ),
          );
        }
        if (parts[2] === "runs" && parts[3]) {
          const run = app.store.get(parts[3]);
          if (parts.length === 4 && method === "GET")
            return send(200, app.detail(run.id));
          if (parts[4] === "events" && method === "GET") {
            const after = Number(
              url.searchParams.get("after") ??
                req.headers["last-event-id"] ??
                0,
            );
            if (!Number.isSafeInteger(after) || after < 0)
              throw new Error("Invalid event cursor");
            if (req.headers.accept !== "text/event-stream")
              return send(200, app.store.events(run.id, after).slice(0, 500));
            res.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
              "X-Accel-Buffering": "no",
            });
            let cursor = after;
            const flush = () => {
              for (const e of app.store.events(run.id, cursor).slice(0, 100)) {
                cursor = e.sequence;
                res.write(`id: ${cursor}\ndata: ${JSON.stringify(e)}\n\n`);
              }
              res.write(": heartbeat\n\n");
            };
            flush();
            const timer = setInterval(flush, 1000);
            req.on("close", () => clearInterval(timer));
            return;
          }
          if (parts[4] === "cancel" && method === "POST") {
            if (JSON.parse(run.config_json).parentRunId)
              throw new Error("Cancel the parent run, not an individual child");
            app.store.requestCancel(run.id);
            return send(202, { requested: true });
          }
          if (parts[4] === "comments" && method === "POST") {
            const input = await body(req);
            return send(201, app.proposeComments(run.id, input.findingIds));
          }
          if (parts[4] === "resume" && method === "POST") {
            if (JSON.parse(run.config_json).parentRunId)
              throw new Error("Resume the parent run, not an individual child");
            if (["FAILED", "COMPLETED", "CANCELLED"].includes(run.status))
              throw new Error(
                "Terminal runs cannot be resumed; create a new run",
              );
            app.data.enqueue(run.id);
            return send(202, { queued: true });
          }
          if (parts[4] === "artifacts" && parts[5] && method === "GET") {
            const artifact = app.store
              .artifacts(run.id)
              .find((a) => a.id === parts[5]);
            if (!artifact) return send(404, { error: "Artifact not found" });
            return send(200, JSON.parse(app.store.read(artifact)));
          }
        }
        if (path === "/api/v1/repositories" && method === "GET")
          return send(200, app.data.repositories());
        if (path === "/api/v1/repositories" && method === "POST")
          return send(201, app.register(await body(req)));
        if (path === "/api/v1/workspaces" && method === "GET")
          return send(200, app.data.workspaceGroups());
        if (path === "/api/v1/workspaces" && method === "POST")
          return send(201, app.multi.register(await body(req)));
        if (path === "/api/v1/workspaces/import" && method === "POST") {
          const input = await body(req);
          return send(201, app.multi.importWorkspace(input.id, input.path));
        }
        if (path === "/api/v1/integrations" && method === "GET")
          return send(200, app.data.integrations());
        if (path === "/api/v1/integrations" && method === "POST") {
          const config = await body(req);
          new InternalClient(config);
          app.data.saveIntegration(config);
          return send(201, { saved: true });
        }
        if (path === "/api/v1/approvals" && method === "GET")
          return send(200, app.data.approvals());
        if (
          parts[2] === "approvals" &&
          parts[3] &&
          parts[4] === "publish" &&
          method === "POST"
        )
          return send(200, await app.publishComments(parts[3]));
        if (parts[2] === "approvals" && parts[3] && method === "POST") {
          const input = await body(req);
          if (!["APPROVED", "REJECTED"].includes(input.decision))
            throw new Error("Invalid decision");
          app.approve(parts[3], input.subjectHash, input.decision);
          return send(200, { recorded: true });
        }
        if (path === "/api/v1/graph" && method === "POST") {
          const input = await body(req);
          return send(200, await app.graph(input.repositoryId, input));
        }
        if (path === "/api/v1/evals" && method === "GET")
          return send(200, evaluation.list());
        if (parts[2] === "evals" && parts[3] && method === "GET")
          return send(200, evaluation.get(parts[3]));
        if (path === "/api/v1/metrics") return send(200, app.metrics());
        if (path === "/api/v1/doctor") return send(200, await app.doctor());
        return send(404, { error: "API route not found" });
      }
      if (req.method !== "GET")
        return send(405, { error: "Method not allowed" });
      const name =
        path === "/app.js"
          ? "app.js"
          : path === "/app.css"
            ? "app.css"
            : "index.html";
      const file = fileURLToPath(
        new URL(`../../web/dist/${name}`, import.meta.url),
      );
      if (!existsSync(file))
        return send(503, {
          error: "Build the local UI with npm run build:web",
        });
      res.writeHead(200, {
        "Content-Type": name.endsWith(".js")
          ? "text/javascript"
          : name.endsWith(".css")
            ? "text/css"
            : "text/html",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy":
          "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'",
      });
      res.end(readFileSync(file));
    } catch (error) {
      if (!res.headersSent)
        send(400, {
          error: error instanceof Error ? error.message : String(error),
        });
      else res.end();
    }
  });
}
export async function serve(root: string, port = 4310, origins: string[] = []) {
  const app = new Application(root);
  const tokenPath = join(root, "server-token");
  if (!existsSync(tokenPath))
    atomicWrite(tokenPath, randomBytes(32).toString("hex"));
  const token = safeRead(tokenPath);
  const server = createApi(app, token, origins);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  console.log(
    `Harness: http://127.0.0.1:${port}\nSession token: ${token}\nForward this port privately in VS Code. Gemini runs through the installed workstation command.`,
  );
  app.store.db
    .prepare("UPDATE jobs SET status='QUEUED' WHERE status='RUNNING'")
    .run();
  let busy = false;
  const controller = new AbortController();
  const timer = setInterval(async () => {
    if (busy) return;
    const job = app.store.db
      .prepare(
        "SELECT run_id FROM jobs WHERE status='QUEUED' ORDER BY created_at LIMIT 1",
      )
      .get() as any;
    if (!job) return;
    const claim = app.store.db
      .prepare(
        "UPDATE jobs SET status='RUNNING' WHERE run_id=? AND status='QUEUED'",
      )
      .run(job.run_id);
    if (!claim.changes) return;
    busy = true;
    try {
      await app.execute(job.run_id, controller.signal);
    } catch (error) {
      console.error(String(error));
      app.store.db
        .prepare("UPDATE jobs SET status='BLOCKED' WHERE run_id=?")
        .run(job.run_id);
    } finally {
      busy = false;
    }
  }, 500);
  const stop = () => {
    clearInterval(timer);
    controller.abort();
    server.close();
    const wait = setInterval(() => {
      if (!busy) {
        clearInterval(wait);
        app.close();
      }
    }, 100);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return server;
}
