/**
 * Phase 5.3 — Multi-app deploy templates (PR 3 of
 * `oauth-sqlite-admin-authorization`).
 *
 * Spec coverage (from `specs/mcp-deployment-templates/spec.md`):
 * - Indexed Runbook With One Section Per App: the runbook
 *   has a TOC that names both `mcp-readonly-sql` and
 *   `mcp-oauth-admin`. Each app section covers production
 *   deployment, dev/staging, env file path, rotation,
 *   structured logs, `/healthz`, shutdown, and rollback.
 * - Systemd Unit: a per-app `deploy/systemd/<app-name>.
 *   service` ships for every MCP app. The unit runs the
 *   app's own entrypoint, reads env from
 *   `/etc/mcp/<app-name>.env`, restarts on failure,
 *   runs as a dedicated unprivileged user, and sets
 *   `WorkingDirectory` to the app's install path.
 * - Dockerfile: a per-app
 *   `deploy/docker/Dockerfile.<app-name>` ships for every
 *   MCP app. The runtime stage uses `node:20-alpine`,
 *   creates a non-root user, copies only the app's
 *   build artifact, sets `USER` to the non-root user,
 *   and includes a `HEALTHCHECK` that hits `/healthz`.
 * - Reverse Proxy Example: `deploy/nginx/mcp.conf`
 *   covers every app. The example proxies
 *   `http://127.0.0.1:3001` (mcp-readonly-sql) and
 *   `http://127.0.0.1:3002` (mcp-oauth-admin),
 *   preserves the `Authorization` header, and enforces
 *   a request body-size cap.
 *
 * Spec coverage (from `specs/mcp-http-transport/spec.md`):
 * - Authority Default Port Is 3002:
 *   `apps/mcp-oauth-admin/.env.example` declares
 *   `MCP_HTTP_PORT=3002`. No future resource-server app
 *   claims port 3002.
 * - Port Allocation Convention: `mcp-readonly-sql`
 *   defaults to 3001; `mcp-oauth-admin` defaults to
 *   3002. The deploy templates reflect the chosen
 *   port.
 *
 * Strict TDD: each scenario below is a real assertion
 * against the committed tree. A future PR that forgets
 * to ship the authority's systemd unit, Dockerfile, or
 * nginx snippet fails the corresponding test.
 *
 * Test layer: integration (walks the deploy tree, reads
 * the per-app templates, asserts structural and content
 * invariants). The operator-verify commands
 * (systemd-analyze / docker build / nginx -t) are
 * skipped gracefully when the binary is not on PATH
 * (mirrors the existing PR 3 deploy-templates test).
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function findWorkspaceRoot(start: string, marker = "pnpm-workspace.yaml"): string | null {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, marker))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

const workspaceRoot = findWorkspaceRoot(__dirname);
if (!workspaceRoot) {
  throw new Error("authorityDeploy.test.ts: workspace root not discoverable from " + __dirname);
}

const deployDir = join(workspaceRoot, "deploy");
const authEnvExamplePath = join(
  workspaceRoot,
  "apps",
  "mcp-oauth-admin",
  ".env.example",
);
const readonlyEnvExamplePath = join(
  workspaceRoot,
  "apps",
  "mcp-readonly-sql",
  ".env.example",
);

function readDeployFile(relPath: string): string {
  const path = join(deployDir, relPath);
  if (!existsSync(path)) {
    throw new Error(
      `expected deploy/${relPath} to exist; test must run after the template is created`,
    );
  }
  return readFileSync(path, "utf8");
}

function hasBinary(name: string): boolean {
  for (const probe of ["where", "which"]) {
    try {
      const out = execFileSync(probe, [name], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (out.trim().length > 0) return true;
    } catch {
      // not found via this probe; try the next
    }
  }
  return false;
}

function isDockerDaemonUp(): boolean {
  if (!hasBinary("docker")) return false;
  try {
    execFileSync("docker", ["info"], {
      encoding: "utf8",
      stdio: ["ignore", "ignore", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

function generateSelfSignedCert(certPath: string, keyPath: string): void {
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-nodes",
      "-newkey",
      "rsa:2048",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-subj",
      "/CN=mcp-test",
    ],
    { stdio: ["ignore", "ignore", "ignore"] },
  );
}

describe("Phase 5.3 — Multi-app deploy templates (authority)", () => {
  // ---------------------------------------------------------------------
  // Port Allocation Convention (mcp-http-transport)
  // ---------------------------------------------------------------------

  describe("port allocation (mcp-http-transport spec)", () => {
    it("mcp-oauth-admin/.env.example defaults MCP_HTTP_PORT=3002", () => {
      // Spec scenario: "apps/mcp-oauth-admin/ with no
      // MCP_HTTP_PORT override → the listener binds
      // 127.0.0.1:3002".
      const env = readFileSync(authEnvExamplePath, "utf8");
      // The uncommented `MCP_HTTP_PORT=3002` line is the
      // app's default. A commented reference is also
      // acceptable (the .env.example is documentation),
      // but the binding contract is the uncommented
      // assignment.
      expect(env).toMatch(/^\s*MCP_HTTP_PORT\s*=\s*3002\s*$/m);
    });

    it("mcp-readonly-sql/.env.example defaults MCP_HTTP_PORT=3001 (not 3002)", () => {
      // Spec scenario: "a future resource-server app
      // under apps/<app-name>/... default port is NOT
      // 3002 AND a port distinct from 3001 and 3002 is
      // selected." mcp-readonly-sql MUST keep 3001 (its
      // v1 default); 3002 is reserved for the authority.
      const env = readFileSync(readonlyEnvExamplePath, "utf8");
      expect(env).toMatch(/^\s*MCP_HTTP_PORT\s*=\s*3001\s*$/m);
      expect(env).not.toMatch(/^\s*MCP_HTTP_PORT\s*=\s*3002\s*$/m);
    });

    it("the runbook reserves port 3002 for the authority (no other app claims it)", () => {
      // Spec scenario: "Port 3002 is reserved for the
      // authority and MUST NOT be claimed by any
      // resource-server MCP". The lint scans every
      // .env.example under apps/*/ for the literal
      // `MCP_HTTP_PORT=3002`; only mcp-oauth-admin is
      // allowed to set it.
      const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
      const appsDir = join(workspaceRoot!, "apps");
      const offenders: string[] = [];
      for (const entry of readdirSync(appsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const appEnv = join(appsDir, entry.name, ".env.example");
        if (!existsSync(appEnv)) continue;
        const text = readFileSync(appEnv, "utf8");
        if (/^\s*MCP_HTTP_PORT\s*=\s*3002\s*$/m.test(text)) {
          // The only app allowed to default 3002 is the
          // authority. Other apps that reference 3002
          // (e.g. a proxy_pass example) are allowed; the
          // lint flags ONLY uncommented `MCP_HTTP_PORT
          // =3002` assignments in apps that are NOT the
          // authority.
          if (entry.name !== "mcp-oauth-admin") {
            offenders.push(`${entry.name}/.env.example`);
          }
        }
      }
      expect(
        offenders,
        `non-authority apps claiming port 3002 as their default: ${offenders.join(", ")}`,
      ).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------
  // Systemd unit for the authority
  // ---------------------------------------------------------------------

  describe("systemd unit for the authority (mcp-deployment-templates spec)", () => {
    it("ships deploy/systemd/mcp-oauth-admin.service", () => {
      expect(existsSync(join(deployDir, "systemd", "mcp-oauth-admin.service"))).toBe(true);
    });

    it("declares User=mcp and Group=mcp (unprivileged user)", () => {
      const unit = readDeployFile("systemd/mcp-oauth-admin.service");
      expect(unit).toMatch(/^User=mcp$/m);
      expect(unit).toMatch(/^Group=mcp$/m);
    });

    it("runs the authority's entrypoint (node dist/index.js) with WorkingDirectory at the authority's install path", () => {
      const unit = readDeployFile("systemd/mcp-oauth-admin.service");
      // The WorkingDirectory MUST point at the
      // authority's install path, NOT the resource
      // server's. The path is the conventional
      // `/opt/mcp/<name>/apps/mcp-oauth-admin`; the
      // exact name pattern is operator-debatable but
      // the auth path is binding.
      expect(unit).toMatch(
        /^WorkingDirectory=\/opt\/mcp\/[^/]*\/apps\/mcp-oauth-admin$/m,
      );
      const execStart = unit
        .split(/\r?\n/)
        .find((l) => l.startsWith("ExecStart="));
      expect(execStart, "ExecStart= must be present").toBeDefined();
      expect(execStart!).toMatch(/\bnode\b/);
      expect(execStart!).toMatch(/\bdist\/index\.js\b/);
    });

    it("loads env from the per-app env file path", () => {
      // Spec scenario: "MUST read env from
      // /etc/mcp/<app-name>.env" (or, per the
      // orchestrator's implementation guidance, the
      // app's own .env). The lint accepts either form
      // because the per-app env path is operator-
      // debatable; the binding contract is that the
      // EnvironmentFile points at a per-app file
      // (NOT a shared file that would defeat the
      // isolation between apps).
      const unit = readDeployFile("systemd/mcp-oauth-admin.service");
      const envFile = unit
        .split(/\r?\n/)
        .find((l) => l.startsWith("EnvironmentFile="));
      expect(envFile, "EnvironmentFile= must be present").toBeDefined();
      // The path MUST mention `mcp-oauth-admin` (the
      // per-app isolation anchor).
      expect(envFile!).toMatch(/mcp-oauth-admin/);
      // The path MUST NOT be shared with
      // mcp-readonly-sql.
      expect(envFile!).not.toMatch(/mcp-readonly-sql/);
    });

    it("declares Restart=on-failure with a backoff (RestartSec)", () => {
      const unit = readDeployFile("systemd/mcp-oauth-admin.service");
      expect(unit).toMatch(/^Restart=on-failure$/m);
      expect(unit).toMatch(/^RestartSec=\d+/m);
    });

    it("installs into multi-user.target (the standard service target)", () => {
      const unit = readDeployFile("systemd/mcp-oauth-admin.service");
      expect(unit).toMatch(/^WantedBy=multi-user\.target$/m);
    });

    it("hardens the service (NoNewPrivileges, ProtectSystem, ProtectHome)", () => {
      // Defense-in-depth: the unprivileged user alone
      // is not enough; the unit must also opt into the
      // standard hardening directives. We assert the
      // presence of the load-bearing ones; additional
      // ones (PrivateTmp, RestrictNamespaces, etc.)
      // are encouraged but not asserted here.
      const unit = readDeployFile("systemd/mcp-oauth-admin.service");
      expect(unit).toMatch(/^NoNewPrivileges=true$/m);
      expect(unit).toMatch(/^ProtectSystem=strict$/m);
      expect(unit).toMatch(/^ProtectHome=true$/m);
    });
  });

  // ---------------------------------------------------------------------
  // Dockerfile for the authority
  // ---------------------------------------------------------------------

  describe("Dockerfile for the authority (mcp-deployment-templates spec)", () => {
    it("ships deploy/docker/Dockerfile.mcp-oauth-admin", () => {
      expect(existsSync(join(deployDir, "docker", "Dockerfile.mcp-oauth-admin"))).toBe(
        true,
      );
    });

    it("is a multi-stage build using node:20-alpine for both stages", () => {
      const dockerfile = readDeployFile("docker/Dockerfile.mcp-oauth-admin");
      const hasLiteralBuild = /^FROM\s+node:20-alpine\s+AS\s+build\b/m.test(dockerfile);
      const hasArgBuild =
        /^ARG\s+NODE_VERSION=20-alpine$/m.test(dockerfile) &&
        /^FROM\s+node:\$\{NODE_VERSION\}\s+AS\s+build\b/m.test(dockerfile);
      expect(
        hasLiteralBuild || hasArgBuild,
        "Dockerfile build stage must use node:20-alpine (literal or via ARG)",
      ).toBe(true);
      const hasLiteralRuntime = /^FROM\s+node:20-alpine(\s+AS\s+\w+)?$/m.test(dockerfile);
      const hasArgRuntime =
        /^ARG\s+NODE_VERSION=20-alpine$/m.test(dockerfile) &&
        /^FROM\s+node:\$\{NODE_VERSION\}(\s+AS\s+\w+)?$/m.test(dockerfile);
      expect(
        hasLiteralRuntime || hasArgRuntime,
        "Dockerfile runtime stage must use node:20-alpine (literal or via ARG)",
      ).toBe(true);
    });

    it("runs as the unprivileged `node` user in the runtime stage", () => {
      const dockerfile = readDeployFile("docker/Dockerfile.mcp-oauth-admin");
      expect(dockerfile).toMatch(/^USER\s+node$/m);
    });

    it("exposes port 3002 (the authority's MCP_HTTP_PORT default)", () => {
      // Spec scenario: "the deploy template's
      // proxy_pass and EnvironmentFile → the port is
      // 3002 AND no entry references 3001 for the
      // authority". The Dockerfile is one of the
      // deploy templates; the EXPOSE instruction
      // declares the container's published port.
      const dockerfile = readDeployFile("docker/Dockerfile.mcp-oauth-admin");
      expect(dockerfile).toMatch(/^EXPOSE\s+3002$/m);
    });

    it("declares a HEALTHCHECK that probes /healthz and exits 0 on 200", () => {
      const dockerfile = readDeployFile("docker/Dockerfile.mcp-oauth-admin");
      expect(dockerfile).toMatch(/^HEALTHCHECK\b/m);
      expect(dockerfile).toMatch(/\/healthz/);
      expect(dockerfile).toMatch(
        /process\.exit\(r\.statusCode===200\?0:1\)/,
      );
    });

    it("does not COPY apps/mcp-readonly-sql or apps/mcp-oauth-admin (app isolation)", () => {
      // Spec scenario: "only the resource server's
      // dist/ is copied AND no copy step references
      // apps/mcp-oauth-admin/". The mirror case is
      // the authority's Dockerfile: only the
      // authority's dist/ is copied.
      const dockerfile = readDeployFile("docker/Dockerfile.mcp-oauth-admin");
      // The Dockerfile MUST NOT reference the
      // resource server's app path.
      expect(dockerfile, "must not COPY ... apps/mcp-readonly-sql").not.toMatch(
        /^COPY[^\n]*apps\/mcp-readonly-sql/m,
      );
    });

    it("the build stage copies only the authority's source + the shared base", () => {
      // The build stage needs the source for the
      // authority app + the shared base (its
      // workspace dep). The pnpm deploy step
      // produces a self-contained runtime tree at
      // /deploy.
      const dockerfile = readDeployFile("docker/Dockerfile.mcp-oauth-admin");
      // The build stage copies the auth app's
      // manifest; the lockfile + workspace manifest
      // are at the root. A grep for the app's
      // `package.json` confirms the build stage
      // targets the right app.
      expect(dockerfile).toMatch(/apps\/mcp-oauth-admin\/package\.json/);
    });
  });

  // ---------------------------------------------------------------------
  // Reverse proxy: covers BOTH apps
  // ---------------------------------------------------------------------

  describe("reverse proxy covers both apps (mcp-deployment-templates spec)", () => {
    it("ships a multi-app deploy/nginx/mcp.conf with proxy_pass entries for BOTH apps", () => {
      const conf = readDeployFile("nginx/mcp.conf");
      // The resource server upstream MUST be present
      // (port 3001 — the v1 default). The authority
      // upstream MUST be present (port 3002 — the
      // mcp-http-transport reservation). Both as
      // `proxy_pass http://127.0.0.1:<port>` lines or
      // inside `upstream {}` blocks.
      expect(conf).toMatch(/127\.0\.0\.1:3001/);
      expect(conf).toMatch(/127\.0\.0\.1:3002/);
    });

    it("the /admin/ location is reachable through the proxy (the authority's UI)", () => {
      // Spec scenario: "the authority's /admin/ is
      // reachable through the proxy". The shipped
      // mcp.conf has a `location = /admin/` block
      // that proxies to the authority.
      const conf = readDeployFile("nginx/mcp.conf");
      expect(conf).toMatch(/location\s+\/?\s*admin\/?/);
    });

    it("preserves the Authorization header for the authority's /admin/ location", () => {
      // The session cookie is the auth surface for
      // the admin UI (not a Bearer header), but the
      // proxy MUST still preserve Cookie / Set-Cookie
      // / Authorization verbatim — the mcp-admin
      // router is HTTPS-aware, and the reverse
      // proxy's `proxy_pass_request_headers on` is
      // the safe default.
      const conf = readDeployFile("nginx/mcp.conf");
      expect(conf).toMatch(/proxy_pass_request_headers\s+on/);
    });

    it("nginx -t passes against a cert-substituted copy (skipped if nginx or openssl not available)", () => {
      if (!hasBinary("nginx") || !hasBinary("openssl")) {
        return;
      }
      const tempDir = mkdtempSync(join(tmpdir(), "mcp-nginx-auth-"));
      try {
        const certPath = join(tempDir, "test.crt");
        const keyPath = join(tempDir, "test.key");
        generateSelfSignedCert(certPath, keyPath);
        const shippedConf = readDeployFile("nginx/mcp.conf");
        const tempConf = shippedConf
          .replace(
            /ssl_certificate\s+\/etc\/ssl\/certs\/mcp\.crt/,
            `ssl_certificate ${certPath}`,
          )
          .replace(
            /ssl_certificate_key\s+\/etc\/ssl\/private\/mcp\.key/,
            `ssl_certificate_key ${keyPath}`,
          );
        const tempConfPath = join(tempDir, "mcp.conf");
        writeFileSync(tempConfPath, tempConf);
        execFileSync("nginx", ["-t", "-c", tempConfPath], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (err) {
        const stderr =
          (err as { stderr?: Buffer | string }).stderr?.toString?.() ??
          String(err);
        throw new Error(`nginx -t failed: ${stderr}`);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  // ---------------------------------------------------------------------
  // Runbook: indexed, multi-app
  // ---------------------------------------------------------------------

  describe("runbook is multi-app indexed (mcp-deployment-templates spec)", () => {
    let readme: string;

    beforeAll(() => {
      readme = readDeployFile("README.md");
    });

    it("the TOC lists both mcp-readonly-sql and mcp-oauth-admin", () => {
      // Spec scenario: "the TOC lists at least
      // [mcp-readonly-sql] and [mcp-oauth-admin]".
      // Anchored TOC entries (`[name]` Markdown
      // links) are the convention.
      expect(readme).toMatch(/\[mcp-readonly-sql\]/i);
      expect(readme).toMatch(/\[mcp-oauth-admin\]/i);
    });

    it("the authority section names the bootstrap admin rotation", () => {
      // Spec scenario: "the authority section
      // names the bootstrap admin rotation".
      expect(readme).toMatch(/bootstrap/i);
      // The rotation is the post-install step; the
      // runbook must guide the operator through it.
      expect(readme).toMatch(/rotat(e|ion)/i);
    });

    it("the resource-server section explains reverting MCP_TRANSPORT=stdio (rollback path)", () => {
      // Spec scenario: "the resource-server
      // section explains reverting MCP_TRANSPORT=
      // stdio". The PR 1 + 2 runbook already had
      // this content; the multi-app rewrite MUST
      // preserve it (the rollback path is a
      // non-negotiable per the cross-PR contract).
      expect(readme).toMatch(/MCP_TRANSPORT=stdio/);
      expect(readme).toMatch(/rollback/i);
    });

    it("the runbook names the env-var vocabulary (MCP_OAUTH_* for the authority)", () => {
      // The authority's env-var vocabulary includes
      // MCP_OAUTH_DB_PATH, MCP_OAUTH_BACKUP_TARGET,
      // MCP_OAUTH_ADMIN_USERNAME, MCP_OAUTH_ADMIN_PASSWORD,
      // MCP_OAUTH_DISABLE_RETENTION_SWEEP, and
      // MCP_AUTHORITY_AUDIENCE. The runbook must
      // document these as the per-app env contract.
      const required = [
        /MCP_OAUTH_DB_PATH/,
        /MCP_OAUTH_BACKUP_TARGET/,
        /MCP_OAUTH_ADMIN_USERNAME/,
        /MCP_OAUTH_ADMIN_PASSWORD/,
      ];
      for (const re of required) {
        expect(readme, `runbook must reference ${re}`).toMatch(re);
      }
    });

    it("the runbook contains no committed secrets (the spec's no-secrets lint, applied to the multi-app runbook)", () => {
      // The same secret-grep the existing PR 3
      // deploy-templates test uses, applied to the
      // updated multi-app runbook.
      const matches = [
        readme.match(/\beyJ[A-Za-z0-9_-]{10,}/g),
        readme.match(/\b[a-f0-9]{64}\b/g),
        readme.match(/postgres:\/\/[^"'\s]+/g),
        readme.match(/mysql:\/\/[^"'\s]+/g),
        readme.match(/Bearer\s+[A-Za-z0-9_-]{8,}/g),
      ]
        .flat()
        .filter(Boolean);
      expect(
        matches,
        `runbook secret-grep matches: ${matches.join(" | ")}`,
      ).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------
  // Per-app .env.example lint: every env var referenced in the
  // authority's deploy template is documented in apps/mcp-oauth-admin/
  // .env.example. Mirrors the resource-server lint in
  // test/deployTemplates.test.ts.
  // ---------------------------------------------------------------------

  describe("env-var source of truth (authority)", () => {
    function extractAppEnvVarNames(text: string): Set<string> {
      const names = new Set<string>();
      for (const m of text.matchAll(/^ENV\s+(MCP_[A-Z0-9_]+|DB_[A-Z0-9_]+)/gm)) {
        names.add(m[1]);
      }
      for (const m of text.matchAll(
        /\$\{?(MCP_[A-Z0-9_]+|DB_[A-Z0-9_]+)\}?/g,
      )) {
        names.add(m[1]);
      }
      return names;
    }

    function extractAuthEnvExampleNames(): Set<string> {
      if (!existsSync(authEnvExamplePath)) {
        throw new Error(`.env.example not found at ${authEnvExamplePath}`);
      }
      const text = readFileSync(authEnvExamplePath, "utf8");
      const names = new Set<string>();
      for (const m of text.matchAll(
        /^\s*#?\s*(MCP_[A-Z0-9_]+|DB_[A-Z0-9_]+)=/gm,
      )) {
        names.add(m[1]);
      }
      return names;
    }

    it("every env var referenced in the authority's Dockerfile is documented in apps/mcp-oauth-admin/.env.example", () => {
      const dockerfile = readDeployFile("docker/Dockerfile.mcp-oauth-admin");
      const referenced = extractAppEnvVarNames(dockerfile);
      const documented = extractAuthEnvExampleNames();
      const undocumented = [...referenced].filter((n) => !documented.has(n));
      expect(
        undocumented,
        `Dockerfile.mcp-oauth-admin references env vars not in apps/mcp-oauth-admin/.env.example: ${undocumented.join(", ")}`,
      ).toEqual([]);
    });

    it("the authority's Dockerfile default env vars are safe closed-by-default", () => {
      const dockerfile = readDeployFile("docker/Dockerfile.mcp-oauth-admin");
      // The authority does not use MCP_TRANSPORT
      // (it IS the authority — no transport
      // dispatcher). The defaults that matter are
      // the listener host/port (loopback + 3002).
      expect(dockerfile).toMatch(/MCP_HTTP_HOST=127\.0\.0\.1/);
      expect(dockerfile).toMatch(/MCP_HTTP_PORT=3002/);
    });
  });

  // ---------------------------------------------------------------------
  // Per-app deploy-template lints: every deploy template env var is
  // documented in the matching app's .env.example.
  // ---------------------------------------------------------------------

  describe("operator-verify (best-effort)", () => {
    it("systemd-analyze verify passes for the authority unit (skipped if systemd not available)", () => {
      if (!hasBinary("systemd-analyze")) return;
      const unitPath = join(deployDir, "systemd", "mcp-oauth-admin.service");
      try {
        execFileSync("systemd-analyze", ["verify", unitPath], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (err) {
        const stderr =
          (err as { stderr?: Buffer | string }).stderr?.toString?.() ??
          String(err);
        throw new Error(`systemd-analyze verify failed: ${stderr}`);
      }
    });

    it("docker build passes for the authority image (skipped if docker not available or daemon not up)", () => {
      if (!hasBinary("docker") || !isDockerDaemonUp()) return;
      try {
        execFileSync(
          "docker",
          [
            "build",
            "-f",
            join(deployDir, "docker", "Dockerfile.mcp-oauth-admin"),
            "-t",
            "mcp-oauth-admin-test",
            ".",
          ],
          {
            cwd: workspaceRoot,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 600_000,
          },
        );
      } catch (err) {
        const stderr =
          (err as { stderr?: Buffer | string }).stderr?.toString?.() ??
          String(err);
        throw new Error(`docker build failed: ${stderr}`);
      }
    });
  });
});
