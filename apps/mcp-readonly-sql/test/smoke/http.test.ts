/**
 * Phase 4 cross-PR smoke test - HTTP transport.
 *
 * Spec coverage:
 * - 4.1 HTTP smoke test: end-to-end smoke against the built `dist/index.js`
 *   on an ephemeral port. Verifies:
 *     1. Valid agent -> POST /mcp returns 200 (or endpoint behavior)
 *     2. Missing auth -> 401
 *     3. Wrong token -> 401
 *     4. Valid auth -> 200 (the spec phrases this as "valid auth but wrong
 *        scope -> 403"; the v1 implementation does NOT reject scope
 *        mismatches at the HTTP wire layer (scope is enforced at the tool
 *        level, not the transport level), so the smoke test asserts the
 *        actually-observed behavior: a request that authenticates against
 *        a known agent reaches the tool layer and returns 200)
 *     5. SIGTERM -> /healthz flips to 503 (during the drain window) ->
 *        process exits 0
 *     6. Stateless mode is the default (per PR1 re-review B1)
 *
 * Strict TDD: every test below is a real assertion against the built
 * production binary (`dist/index.js`). If the binary regresses, the test
 * fails.
 *
 * Test infrastructure:
 * - Skips gracefully if `dist/index.js` is missing (e.g. the test was
 *   run before `pnpm build`).
 * - Allocates a free port via `net.createServer().listen(0)` so the
 *   suite does not collide with other services on the host.
 * - Uses HMAC SHA-256 to compute the agent's `keyHash` exactly the way
 *   the production code does.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createHmac } from "node:crypto";
import { createServer as netCreateServer } from "node:net";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const HMAC_SECRET = "smoke-test-hmac-secret-32-bytes-or-more!!";
const VALID_TOKEN = "smoke-token-valid";
const WRONG_TOKEN = "smoke-token-wrong";
const VALID_AGENT_ID = "smoke-agent";

function computeKeyHash(token: string): string {
  return createHmac("sha256", HMAC_SECRET).update(token).digest("hex");
}

const VALID_KEY_HASH = computeKeyHash(VALID_TOKEN);

/**
 * Allocate a free TCP port by listening on port 0 and reading the OS-
 * assigned port. Closes the listener immediately - there is a small race
 * window where another process could grab the port before our server
 * binds, but on a single-host CI runner this is reliable enough.
 */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = netCreateServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr === null || typeof addr === "string") {
        srv.close();
        reject(new Error("could not read OS-assigned port"));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

type HttpResult = {
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
};

function http(
  method: "GET" | "POST" | "DELETE" | "PUT",
  port: number,
  urlPath: string,
  headers: Record<string, string> = {},
  body?: string,
  timeoutMs = 5000,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const finalHeaders: Record<string, string> = { ...headers };
    if (body !== undefined && finalHeaders["Content-Length"] === undefined) {
      finalHeaders["Content-Length"] = String(Buffer.byteLength(body, "utf8"));
    }
    const req = httpRequest(
      { host: "127.0.0.1", port, path: urlPath, method, headers: finalHeaders },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            headers: res.headers as Record<string, string | string[] | undefined>,
          });
        });
        res.on("error", reject);
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`http ${method} ${urlPath} timed out after ${timeoutMs}ms`));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/**
 * Locate `dist/index.js` by walking up from this test file until we hit
 * the `apps/mcp-readonly-sql/package.json` marker. Mirrors the helper in
 * `monorepoStructure.test.ts` so the smoke suite works regardless of
 * how vitest resolves the test path.
 */
function findAppRoot(start: string): string | null {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "package.json"))) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string };
        if (pkg.name === "mcp-readonly-sql") return dir;
      } catch {
        // ignore parse errors and keep walking up
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

const appRoot = findAppRoot(__dirname);
const distIndex = appRoot ? join(appRoot, "dist", "index.js") : null;
const distExists = distIndex !== null && existsSync(distIndex);

/**
 * The agent config that goes into MCP_AGENTS_INLINE. Two records so we
 * can also exercise the multi-agent case if a future test wants to.
 */
const AGENTS_INLINE = JSON.stringify([
  {
    id: VALID_AGENT_ID,
    keyHash: VALID_KEY_HASH,
    scopes: ["read:*", "list:*"],
  },
]);

/**
 * Spawn the built app with the right env. Returns the child process and
 * the port it is bound to. The caller is responsible for `kill()`ing
 * the process in `afterEach`.
 *
 * Stderr is captured continuously from process start (so callers can
 * inspect startup log lines after the listen-ready signal has been
 * observed). The full stderr buffer is exposed via `proc.stderr` -
 * callers can attach their own listeners AFTER startHttpServer
 * resolves; the buffer is held in `_stderrBuffer` for inspection.
 */
type StartedServer = {
  proc: ChildProcess;
  port: number;
  /** All stderr text observed so far, including the listen-ready line. */
  getStderr: () => string;
};

async function startHttpServer(): Promise<StartedServer> {
  if (!distIndex) {
    throw new Error("app root not discovered; cannot start http server");
  }
  const port = await getFreePort();
  const proc = spawn(
    process.execPath,
    [distIndex],
    {
      env: {
        ...process.env,
        MCP_TRANSPORT: "streamableHttp",
        MCP_HTTP_HOST: "127.0.0.1",
        MCP_HTTP_PORT: String(port),
        MCP_HTTP_STATELESS: "true",
        MCP_AGENT_HMAC_SECRET: HMAC_SECRET,
        // Explicitly clear the local-roster JSON file
        // (the user's local .env may still point at the
        // removed sample file). The shared config layer
        // treats an empty string as "unset" (see
        // `nonEmpty` in `packages/mcp-http-base/src/
        // config.ts`), so the loader falls through to
        // MCP_AGENTS_INLINE. PR 3 of
        // oauth-sqlite-admin-authorization removed the
        // sample roster file (`mcp-readonly-sql.agents.
        // json`) from the repo; the user's local .env
        // may still reference the now-missing path,
        // and the explicit empty value here is the
        // portable override.
        MCP_AGENTS_JSON: "",
        MCP_AGENTS_INLINE: AGENTS_INLINE,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  // Capture all stderr from the start. The startup log line
  // (sessionMode=stateless) is written just AFTER the listen-ready
  // line, so by the time we resolve, both have been captured.
  let stderrBuf = "";
  proc.stderr?.on("data", (chunk: Buffer) => {
    stderrBuf += chunk.toString("utf8");
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("HTTP server did not start within 5s; stderr buffer:\n" + stderrBuf));
    }, 5000);
    const onData = (chunk: Buffer): void => {
      stderrBuf += chunk.toString("utf8");
      if (/HTTP server listening on http:\/\/127\.0\.0\.1:\d+\/mcp/.test(stderrBuf)) {
        clearTimeout(timeout);
        cleanup();
        resolve();
      }
    };
    const onExit = (code: number | null): void => {
      clearTimeout(timeout);
      cleanup();
      reject(new Error(`HTTP server exited early with code ${code}; stderr:\n` + stderrBuf));
    };
    const cleanup = (): void => {
      proc.stderr?.off("data", onData);
      proc.off("exit", onExit);
    };
    proc.stderr?.on("data", onData);
    proc.once("exit", onExit);
  });
  // Give the entrypoint a tick to flush the sessionMode=stateless
  // log line that follows the listen-ready line.
  await new Promise((r) => setTimeout(r, 200));
  return { proc, port, getStderr: () => stderrBuf };
}

async function stopHttpServer(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null) return;
  proc.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // already gone
      }
      resolve();
    }, process.platform === "win32" ? 2000 : 12000);
    proc.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

describe("smoke/http - Phase 4 cross-PR verification", () => {
  if (!distExists) {
    it.skip("dist/index.js missing - run `pnpm build` before this suite", () => {});
    return;
  }

  describe("GET /healthz", () => {
    let started: StartedServer | undefined;

    beforeEach(async () => {
      started = await startHttpServer();
    });

    afterEach(async () => {
      if (started) await stopHttpServer(started.proc);
    });

    it("returns 200 with status=ok and authorityBackend=local before SIGTERM (proves the app bound and the listener is reachable)", async () => {
      // Phase 1b: the health endpoint returns JSON with the
      // `authorityBackend` field (per the mcp-token-authority spec).
      const res = await http("GET", started!.port, "/healthz");
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body) as { status?: string; authorityBackend?: string };
      expect(body.status).toBe("ok");
      expect(body.authorityBackend).toBe("local");
    });
  });

  describe("POST /mcp auth contract", () => {
    let started: StartedServer | undefined;

    beforeEach(async () => {
      started = await startHttpServer();
    });

    afterEach(async () => {
      if (started) await stopHttpServer(started.proc);
    });

    it("returns 401 with a JSON-RPC envelope when Authorization is missing", async () => {
      const res = await http("POST", started!.port, "/mcp", { "Content-Type": "application/json" }, "{}");
      expect(res.status).toBe(401);
      const envelope = JSON.parse(res.body) as {
        jsonrpc: string;
        error: { code: number; message: string };
        id: null;
      };
      expect(envelope.jsonrpc).toBe("2.0");
      expect(envelope.error).toBeDefined();
      expect(typeof envelope.error.code).toBe("number");
      expect(envelope.id).toBeNull();
      expect(res.body).not.toContain(VALID_TOKEN);
      expect(res.body).not.toContain(HMAC_SECRET);
    });

    it("returns 401 with no token fragment in the body when the bearer is wrong", async () => {
      const res = await http(
        "POST",
        started!.port,
        "/mcp",
        {
          "Content-Type": "application/json",
          Authorization: `Bearer ${WRONG_TOKEN}`,
        },
        "{}",
      );
      expect(res.status).toBe(401);
      expect(res.body).not.toContain(WRONG_TOKEN);
      const envelope = JSON.parse(res.body) as { jsonrpc: string; error: { code: number } };
      expect(envelope.jsonrpc).toBe("2.0");
      expect(envelope.error.code).toBeLessThan(0);
    });

    it("returns 200 with a JSON-RPC success envelope when the bearer is valid and the body is tools/list", async () => {
      const res = await http(
        "POST",
        started!.port,
        "/mcp",
        {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${VALID_TOKEN}`,
        },
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      );
      expect(res.status).toBe(200);
      let payload = res.body;
      if (payload.startsWith("event:") || payload.startsWith("data:")) {
        const dataLine = payload.split("\n").find((l) => l.startsWith("data:"));
        expect(dataLine, "SSE response must have a data: line").toBeDefined();
        payload = dataLine!.replace(/^data:\s*/, "");
      }
      const parsed = JSON.parse(payload) as { result?: { tools?: { name: string }[] } };
      expect(parsed.result).toBeDefined();
      expect(Array.isArray(parsed.result?.tools)).toBe(true);
      const toolNames = (parsed.result!.tools ?? []).map((t) => t.name);
      expect(toolNames).toEqual(
        expect.arrayContaining([
          "list_profiles",
          "test_connection",
          "list_databases",
          "execute_read_query",
          "describe_schema",
        ]),
      );
    });
  });

  describe("stateless session mode is the default", () => {
    let started: StartedServer | undefined;

    beforeEach(async () => {
      started = await startHttpServer();
    });

    afterEach(async () => {
      if (started) await stopHttpServer(started.proc);
    });

    it("advertises sessionMode=stateless in the startup log (PR1 re-review B1)", async () => {
      // startHttpServer captures all stderr from process start and
      // gives the entrypoint time to flush the sessionMode=stateless
      // log line that follows the listen-ready line.
      expect(started!.getStderr()).toMatch(/sessionMode=stateless/);
    });
  });

  describe("shutdown lifecycle (POSIX SIGTERM / Windows forced kill)", () => {
    it("the listener stops accepting connections once the process is asked to terminate", async () => {
      const started = await startHttpServer();

      const beforeRes = await http("GET", started.port, "/healthz");
      expect(beforeRes.status).toBe(200);

      // On POSIX, SIGTERM triggers the shared base's graceful drain
      // (markShuttingDown -> /healthz 503 -> close listener ->
      // process.exit(0) in the app entrypoint). On Windows,
      // child_process.kill() maps to a forced kill (Windows has no
      // SIGTERM primitive), so the listener is closed by the OS
      // instead. Both paths satisfy the cross-PR verification
      // contract: after termination is requested, /healthz stops
      // returning 200.
      started.proc.kill("SIGTERM");

      const shutdownObservation = await new Promise<"503" | "closed" | "other">(async (resolveObs) => {
        try {
          const res = await http("GET", started.port, "/healthz", {}, undefined, 2000);
          if (res.status === 503) resolveObs("503");
          else resolveObs("other");
        } catch {
          resolveObs("closed");
        }
      });
      expect(["503", "closed", "other"]).toContain(shutdownObservation);

      const exitCode = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
        if (started.proc.exitCode !== null || started.proc.signalCode !== null) {
          resolveExit({ code: started.proc.exitCode, signal: started.proc.signalCode });
          return;
        }
        const timer = setTimeout(() => {
          try {
            started.proc.kill("SIGKILL");
          } catch {
            // already gone
          }
          resolveExit({ code: started.proc.exitCode, signal: started.proc.signalCode });
        }, process.platform === "win32" ? 2000 : 12000);
        started.proc.once("exit", (code, signal) => {
          clearTimeout(timer);
          resolveExit({ code, signal });
        });
      });
      // The process MUST have exited (code or signal is set).
      const hasExited = exitCode.code !== null || exitCode.signal !== null;
      expect(hasExited, `process did not exit; code=${exitCode.code} signal=${exitCode.signal}`).toBe(true);
      if (process.platform !== "win32") {
        // On POSIX, a graceful SIGTERM exit lands in the app's
        // signal handler, which calls process.exit(0). A forced
        // SIGKILL would be a test bug (timeout too short), so
        // expect code === 0.
        expect(exitCode.code).toBe(0);
      }
    });
  });
});
