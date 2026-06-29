import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { join, resolve, dirname, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Walk up the directory tree from a starting directory until a marker file
 * is found. Returns the directory that contains the marker, or null.
 *
 * Mirrors the helper in `monorepoStructure.test.ts` so deploy-template tests
 * can locate the workspace root regardless of how vitest resolves the
 * `apps/mcp-readonly-sql/test/` path.
 */
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
  throw new Error(
    "deployTemplates.test.ts: workspace root not discoverable from " + __dirname,
  );
}

const deployDir = join(workspaceRoot, "deploy");
const envExamplePath = join(
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
  // Best-effort probe: `where` on Windows, `which` on POSIX.
  for (const probe of ["where", "which"]) {
    try {
      const out = execFileSync(probe, [name], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      if (out.trim().length > 0) return true;
    } catch {
      // not found via this probe; try the next
    }
  }
  return false;
}

/**
 * Probe whether the docker daemon is reachable. The binary can be installed
 * (e.g. Docker Desktop) without the daemon actually running (e.g. WSL not
 * started). `docker info` is the cheap, authoritative probe.
 */
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

/**
 * Generate a throwaway self-signed cert + key to a temp directory. Used by
 * the nginx -t test so the shipped mcp.conf (which references
 * /etc/ssl/certs/mcp.crt) can be validated without a real cert on disk.
 */
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

describe("deploy templates (PR3) — mcp-deployment-templates spec", () => {
  // ---------------------------------------------------------------------
  // Task 3.1 — Systemd Unit
  // ---------------------------------------------------------------------

  describe("systemd unit (task 3.1)", () => {
    it("ships deploy/systemd/mcp-readonly-sql.service", () => {
      // Spec Requirement: Systemd Unit — Scenario: Unit verifies
      expect(existsSync(join(deployDir, "systemd", "mcp-readonly-sql.service"))).toBe(true);
    });

    it("declares User=mcp and Group=mcp (unprivileged user)", () => {
      // Spec Requirement: Systemd Unit — Scenario: Dedicated unprivileged user
      const unit = readDeployFile("systemd/mcp-readonly-sql.service");
      expect(unit).toMatch(/^User=mcp$/m);
      expect(unit).toMatch(/^Group=mcp$/m);
    });

    it("declares Restart=on-failure with a backoff (RestartSec)", () => {
      // Spec Requirement: Systemd Unit — Scenario: Restart on failure
      const unit = readDeployFile("systemd/mcp-readonly-sql.service");
      expect(unit).toMatch(/^Restart=on-failure$/m);
      expect(unit).toMatch(/^RestartSec=\d+/m);
    });

    it("points WorkingDirectory at the app install path", () => {
      // Spec Requirement: Systemd Unit — "MUST set WorkingDirectory to the app's install path"
      const unit = readDeployFile("systemd/mcp-readonly-sql.service");
      expect(unit).toMatch(
        /^WorkingDirectory=\/opt\/mcp\/db\/apps\/mcp-readonly-sql$/m,
      );
    });

    it("loads env from the app .env via EnvironmentFile", () => {
      // Spec Requirement: Systemd Unit — "MUST read env from /etc/mcp/<app-name>.env"
      // The orchestrator's implementation guidance for this PR points
      // EnvironmentFile at the app's own .env (the same file dotenv loads),
      // which keeps a single source of truth. Operators who prefer a
      // separate /etc/mcp/<app>.env can adjust the directive; the runbook
      // documents the convention.
      const unit = readDeployFile("systemd/mcp-readonly-sql.service");
      expect(unit).toMatch(
        /^EnvironmentFile=\/opt\/mcp\/db\/apps\/mcp-readonly-sql\/\.env$/m,
      );
    });

    it("starts the app via `node dist/index.js`", () => {
      // Spec Requirement: Systemd Unit — "MUST run `node dist/index.js`"
      const unit = readDeployFile("systemd/mcp-readonly-sql.service");
      const execStart = unit
        .split(/\r?\n/)
        .find((l) => l.startsWith("ExecStart="));
      expect(execStart, "ExecStart= must be present").toBeDefined();
      expect(execStart!).toMatch(/\bnode\b/);
      expect(execStart!).toMatch(/\bdist\/index\.js\b/);
    });

    it("installs into the multi-user.target for `systemctl enable`", () => {
      const unit = readDeployFile("systemd/mcp-readonly-sql.service");
      expect(unit).toMatch(/^WantedBy=multi-user\.target$/m);
    });

    it("hardens the service (NoNewPrivileges, ProtectSystem)", () => {
      // Defense-in-depth: the unprivileged user alone is not enough; the
      // unit must also opt into the standard hardening directives. We
      // assert the presence of the load-bearing ones; additional ones
      // (PrivateTmp, ProtectHome, RestrictNamespaces, etc.) are encouraged
      // but not asserted here.
      const unit = readDeployFile("systemd/mcp-readonly-sql.service");
      expect(unit).toMatch(/^NoNewPrivileges=true$/m);
      expect(unit).toMatch(/^ProtectSystem=strict$/m);
    });
  });

  // ---------------------------------------------------------------------
  // Task 3.2 — Dockerfile
  // ---------------------------------------------------------------------

  describe("Dockerfile (task 3.2)", () => {
    it("ships deploy/docker/Dockerfile", () => {
      // Spec Requirement: Dockerfile — Scenario: Build succeeds
      expect(existsSync(join(deployDir, "docker", "Dockerfile"))).toBe(true);
    });

    it("is a multi-stage build using node:20-alpine for both stages", () => {
      // Spec Requirement: Dockerfile — "MUST use node:20-alpine"
      // The Dockerfile MAY use either form:
      //   FROM node:20-alpine AS build
      //   ARG NODE_VERSION=20-alpine
      //   FROM node:${NODE_VERSION} AS build
      // Both forms MUST resolve to the spec's base image (node:20-alpine).
      const dockerfile = readDeployFile("docker/Dockerfile");
      const hasLiteralBuild = /^FROM\s+node:20-alpine\s+AS\s+build\b/m.test(dockerfile);
      const hasArgBuild =
        /^ARG\s+NODE_VERSION=20-alpine$/m.test(dockerfile) &&
        /^FROM\s+node:\$\{NODE_VERSION\}\s+AS\s+build\b/m.test(dockerfile);
      expect(
        hasLiteralBuild || hasArgBuild,
        "Dockerfile build stage must use node:20-alpine (literal or via ARG)",
      ).toBe(true);
      // The runtime stage also uses node:20-alpine (the spec's base image).
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
      // Spec Requirement: Dockerfile — Scenario: Non-root user
      const dockerfile = readDeployFile("docker/Dockerfile");
      expect(dockerfile).toMatch(/^USER\s+node$/m);
    });

    it("sets WORKDIR to /app", () => {
      const dockerfile = readDeployFile("docker/Dockerfile");
      expect(dockerfile).toMatch(/^WORKDIR\s+\/app$/m);
    });

    it("declares a HEALTHCHECK that probes /healthz and exits 0 on 200", () => {
      // Spec Requirement: Dockerfile — Scenario: Healthcheck passes
      const dockerfile = readDeployFile("docker/Dockerfile");
      expect(dockerfile).toMatch(/^HEALTHCHECK\b/m);
      // The inline probe must hit the local /healthz endpoint.
      expect(dockerfile).toMatch(/\/healthz/);
      // The probe must exit 0 on 200, non-zero otherwise.
      expect(dockerfile).toMatch(
        /process\.exit\(r\.statusCode===200\?0:1\)/,
      );
    });

    it("copies the .env.example into the runtime image for operator reference", () => {
      const dockerfile = readDeployFile("docker/Dockerfile");
      expect(dockerfile).toMatch(/\.env\.example/);
    });

    it("exposes port 3001 (the app's MCP_HTTP_PORT default)", () => {
      const dockerfile = readDeployFile("docker/Dockerfile");
      expect(dockerfile).toMatch(/^EXPOSE\s+3001$/m);
    });

    it("does not COPY src/ or test/ into the runtime stage", () => {
      // Spec Requirement: Dockerfile — "MUST copy only the app's dist/,
      // package.json, and lockfile (no src/, no test/)"
      const dockerfile = readDeployFile("docker/Dockerfile");
      expect(dockerfile, "must not COPY ... src/").not.toMatch(/^COPY[^\n]*\bsrc\//m);
      expect(dockerfile, "must not COPY ... test/").not.toMatch(/^COPY[^\n]*\btest\//m);
    });
  });

  // ---------------------------------------------------------------------
  // Task 3.3 — Reverse proxy example
  // ---------------------------------------------------------------------

  describe("nginx config (task 3.3)", () => {
    it("ships deploy/nginx/mcp.conf", () => {
      // Spec Requirement: Reverse Proxy Example
      expect(existsSync(join(deployDir, "nginx", "mcp.conf"))).toBe(true);
    });

    it("terminates TLS on port 443", () => {
      // Spec Requirement: Reverse Proxy Example — Scenario: TLS terminates at proxy
      const conf = readDeployFile("nginx/mcp.conf");
      expect(conf).toMatch(/listen\s+443\s+ssl/);
      expect(conf).toMatch(/ssl_certificate\s+\/etc\/ssl\/certs\//);
      expect(conf).toMatch(/ssl_certificate_key\s+\/etc\/ssl\/private\//);
    });

    it("proxies /mcp to http://127.0.0.1:3001 (no TLS upstream)", () => {
      // Spec Requirement: Reverse Proxy Example — Scenario: TLS terminates at proxy
      // AND "MUST proxy_pass to http://127.0.0.1:<app-port>"
      const conf = readDeployFile("nginx/mcp.conf");
      expect(conf).toMatch(/proxy_pass\s+http:\/\/127\.0\.0\.1:3001/);
    });

    it("preserves the Authorization header", () => {
      // Spec Requirement: Reverse Proxy Example — Scenario: Authorization header preserved
      const conf = readDeployFile("nginx/mcp.conf");
      expect(conf).toMatch(
        /proxy_set_header\s+Authorization\s+\$http_authorization\b/,
      );
    });

    it("enforces a 1m body-size cap", () => {
      // Spec Requirement: Reverse Proxy Example — Scenario: Proxy caps request body
      const conf = readDeployFile("nginx/mcp.conf");
      expect(conf).toMatch(/client_max_body_size\s+1m\b/);
    });

    it("does not load-balance across multiple upstream instances (single-process app)", () => {
      // Spec Requirement: Reverse Proxy Example — single upstream on 127.0.0.1:3001
      const conf = readDeployFile("nginx/mcp.conf");
      const upstreamMatch = conf.match(/upstream\s+\w+\s*\{([\s\S]*?)\}/);
      if (upstreamMatch) {
        const body = upstreamMatch[1];
        const serverCount = (body.match(/server\s+127\.0\.0\.1:3001\b/g) || []).length;
        expect(serverCount).toBe(1);
      }
      // Otherwise the config proxies directly via `proxy_pass http://127.0.0.1:3001`
      // and does not need an upstream block — that path is also acceptable.
    });
  });

  // ---------------------------------------------------------------------
  // Task 3.4 — Operator runbook
  // ---------------------------------------------------------------------

  describe("runbook (task 3.4)", () => {
    it("ships deploy/README.md", () => {
      // Spec Requirement: Runbook Contents
      expect(existsSync(join(deployDir, "README.md"))).toBe(true);
    });

    it("covers production deployment via the reverse proxy", () => {
      // Spec Requirement: Runbook Contents — "production deployment via the existing reverse proxy"
      const readme = readDeployFile("README.md");
      expect(readme).toMatch(/reverse proxy/i);
    });

    it("states that TLS terminates at the existing reverse proxy", () => {
      // Spec Requirement: Production TLS Boundary — Scenario: Runbook states the boundary
      const readme = readDeployFile("README.md");
      expect(readme).toMatch(/TLS terminates at/i);
    });

    it("covers dev/staging deployment without TLS (loopback only)", () => {
      // Spec Requirement: Dev/Staging Without TLS — Scenario: Loopback only
      const readme = readDeployFile("README.md");
      expect(readme).toMatch(/dev\/?staging|loopback|127\.0\.0\.1/i);
    });

    it("documents env-var loading and where the .env file lives", () => {
      // Spec Requirement: Runbook Contents — "where env vars are loaded from"
      const readme = readDeployFile("README.md");
      expect(readme).toMatch(/\.env(\.example)?/);
    });

    it("documents HMAC key rotation", () => {
      // Spec Requirement: Runbook Contents — Scenario: Runbook covers rotation
      const readme = readDeployFile("README.md");
      expect(readme).toMatch(/rotate/i);
      // Must name the relevant env vars per the scenario.
      expect(readme).toMatch(/MCP_AGENTS_(JSON|INLINE)/);
      expect(readme).toMatch(/MCP_AGENT_HMAC_SECRET/);
    });

    it("documents how to read structured JSON logs", () => {
      // Spec Requirement: Runbook Contents — "how to read the structured JSON logs"
      const readme = readDeployFile("README.md");
      expect(readme).toMatch(/MCP_LOG_FORMAT|json/i);
    });

    it("documents /healthz and graceful shutdown", () => {
      // Spec Requirement: Runbook Contents — "how to interpret /healthz and shutdown"
      const readme = readDeployFile("README.md");
      expect(readme).toMatch(/\/healthz/);
      expect(readme).toMatch(/shutdown|SIGTERM/i);
    });

    it("documents the stdio fallback / rollback path", () => {
      // Spec Requirement: Runbook Contents — Scenario: Runbook covers rollback
      const readme = readDeployFile("README.md");
      expect(readme).toMatch(/stdio/i);
      expect(readme).toMatch(/MCP_TRANSPORT=stdio|rollback/i);
    });

    it("contains no real or sample secrets (eyJ, 64-char hex, postgres://, mysql://, Bearer)", () => {
      // Spec Requirement: Runbook Contents — Scenario: No secrets in runbook
      // AND orchestrator guidance: "Grep runbook for secrets: no `eyJ`,
      // no 64-char hex, no `postgres://`, no `mysql://`".
      const readme = readDeployFile("README.md");
      // JWT-style eyJ prefix (b64 '{"...' )
      expect(
        readme,
        "runbook must not contain a JWT-style eyJ prefix",
      ).not.toMatch(/\beyJ[A-Za-z0-9_-]{10,}/);
      // 64-char lowercase hex literal (looks like a SHA-256 keyHash)
      expect(
        readme,
        "runbook must not contain a 64-char hex literal (looks like a keyHash)",
      ).not.toMatch(/\b[a-f0-9]{64}\b/);
      // PostgreSQL connection strings
      expect(
        readme,
        "runbook must not contain a postgres:// URL",
      ).not.toMatch(/postgres:\/\/[^"'\s]+/);
      // MySQL connection strings
      expect(
        readme,
        "runbook must not contain a mysql:// URL",
      ).not.toMatch(/mysql:\/\/[^"'\s]+/);
      // Bearer tokens (Bearer + space + 8+ alnum/_/- chars)
      expect(
        readme,
        "runbook must not contain a Bearer token",
      ).not.toMatch(/Bearer\s+[A-Za-z0-9_-]{8,}/);
      // SQL Server connection strings (Server=...;Database=...;)
      expect(
        readme,
        "runbook must not contain a SQL Server connection string",
      ).not.toMatch(/Server=[^"'\s;]+;\s*Database=/i);
    });
  });

  // ---------------------------------------------------------------------
  // Task 3.5 — Template-lint + operator verify
  // ---------------------------------------------------------------------

  describe("template-lint: env-var source of truth (task 3.5)", () => {
    /**
     * Extract every `MCP_*` or `DB_*` env var name referenced in a template.
     * Catches the two patterns a real template uses:
     *  - docker ENV instructions: ENV NAME=value
     *  - inline shell scripts: $NAME or ${NAME}
     * The matcher is deliberately narrow (uppercase + underscore) so
     * nginx/HAProxy placeholders like $host or $remote_addr are not
     * confused with env vars.
     */
    function extractAppEnvVarNames(text: string): Set<string> {
      const names = new Set<string>();
      // ENV NAME=... (Docker)
      for (const m of text.matchAll(/^ENV\s+(MCP_[A-Z0-9_]+|DB_[A-Z0-9_]+)/gm)) {
        names.add(m[1]);
      }
      // ${NAME} or $NAME (uppercase, starts with MCP_ or DB_)
      for (const m of text.matchAll(
        /\$\{?(MCP_[A-Z0-9_]+|DB_[A-Z0-9_]+)\}?/g,
      )) {
        names.add(m[1]);
      }
      return names;
    }

    function extractEnvExampleNames(): Set<string> {
      // PR 3 of `oauth-sqlite-admin-authorization` makes
      // the runbook a multi-app document; the union of
      // env vars from BOTH apps' .env.example files is
      // the "documented" set. The per-app .env.example
      // is the env-var source of truth; the runbook
      // documents the workspace as a whole.
      const names = new Set<string>();
      const paths = [
        envExamplePath,
        // The authority's .env.example lives in a
        // different directory; include it so the
        // runbook's authority-side env references
        // (`MCP_OAUTH_*`, `MCP_AUTHORITY_AUDIENCE`)
        // are recognised as documented.
        join(workspaceRoot, "apps", "mcp-oauth-admin", ".env.example"),
      ];
      for (const p of paths) {
        if (!existsSync(p)) continue;
        const text = readFileSync(p, "utf8");
        // Match both active lines (`MCP_FOO=bar`) and
        // commented examples (`# MCP_FOO=bar`). A
        // commented line in `.env.example` is still a
        // documented var — the operator uncomments it
        // to enable the value.
        for (const m of text.matchAll(
          /^\s*#?\s*(MCP_[A-Z0-9_]+|DB_[A-Z0-9_]+)=/gm,
        )) {
          names.add(m[1]);
        }
      }
      return names;
    }

    it("every env var referenced in the Dockerfile is documented in .env.example", () => {
      // Spec Requirement: Environment File Is Single Source Of Truth
      // — Scenario: Undocumented var rejected
      const dockerfile = readDeployFile("docker/Dockerfile");
      const referenced = extractAppEnvVarNames(dockerfile);
      const documented = extractEnvExampleNames();
      const undocumented = [...referenced].filter((n) => !documented.has(n));
      expect(
        undocumented,
        `Dockerfile references env vars not in .env.example: ${undocumented.join(", ")}`,
      ).toEqual([]);
    });

    it("Dockerfile default env vars are safe closed-by-default", () => {
      // The Dockerfile's ENV defaults should match the spec'd safe defaults.
      // The ENV may be single-line (ENV NAME=value) or a multi-line
      // continuation (ENV NAME1=value1 \\\n    NAME2=value2 ...). Both
      // forms set the same effective env; the assertion below tolerates
      // either.
      const dockerfile = readDeployFile("docker/Dockerfile");
      expect(dockerfile).toMatch(/MCP_TRANSPORT=streamableHttp/);
      expect(dockerfile).toMatch(/MCP_HTTP_HOST=127\.0\.0\.1/);
      expect(dockerfile).toMatch(/MCP_HTTP_PORT=3001/);
      // Production: TLS terminates at the existing reverse proxy.
      expect(dockerfile).toMatch(/MCP_HTTP_BEHIND_PROXY=true/);
    });

    it("the runbook references only env vars that are documented in .env.example", () => {
      // The runbook is allowed to mention env var NAMES (those are not
      // secrets); what we forbid is a runbook instructing operators to set
      // an env var the app does not read.
      const readme = readDeployFile("README.md");
      const referenced = extractAppEnvVarNames(readme);
      const documented = extractEnvExampleNames();
      const undocumented = [...referenced].filter((n) => !documented.has(n));
      expect(
        undocumented,
        `runbook references env vars not in .env.example: ${undocumented.join(", ")}`,
      ).toEqual([]);
    });
  });

  describe("production TLS boundary (no TLS in app source)", () => {
    /**
     * Spec Requirement: Production TLS Boundary — Scenario: No TLS in app
     * The app MUST NOT ship its own TLS configuration. The
     * `mcp-http-base` shared base and the app's own source tree must not
     * contain `https.createServer` or equivalent.
     */
    const forbiddenPatterns: Array<{ name: string; regex: RegExp }> = [
      { name: "https.createServer", regex: /https\.createServer/ },
      { name: "createSecureServer", regex: /createSecureServer/ },
    ];

    function walkSrcTree(root: string): string[] {
      const out: string[] = [];
      if (!existsSync(root)) return out;
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        const full = join(root, entry.name);
        if (entry.isDirectory()) out.push(...walkSrcTree(full));
        else if (entry.isFile() && /\.(ts|js|mjs|cjs)$/.test(entry.name))
          out.push(full);
      }
      return out;
    }

    for (const { name, regex } of forbiddenPatterns) {
      it(`app + shared base src/ contains no '${name}' (TLS terminates at proxy only)`, () => {
        const roots = [
          join(workspaceRoot, "apps", "mcp-readonly-sql", "src"),
          join(workspaceRoot, "packages", "mcp-http-base", "src"),
        ];
        const offenders: string[] = [];
        for (const root of roots) {
          for (const file of walkSrcTree(root)) {
            const text = readFileSync(file, "utf8");
            if (regex.test(text)) offenders.push(file);
          }
        }
        expect(
          offenders,
          `TLS pattern '${name}' found in app/shared-base source: ${offenders.join(", ")}`,
        ).toEqual([]);
      });
    }
  });

  describe("operator verify commands (task 3.5 — exit 0)", () => {
    /**
     * Spec Scenarios:
     *  - systemd-analyze verify deploy/systemd/mcp-readonly-sql.service → 0
     *  - docker build -f deploy/docker/Dockerfile . → 0
     *  - nginx -t -c deploy/nginx/mcp.conf → 0
     *  - grep runbook for secrets → 0 matches
     * Each command is best-effort: if the binary is not on PATH, the test
     * is skipped and a comment in the failure output records the gap.
     */

    it("systemd-analyze verify passes (skipped if systemd not available)", () => {
      if (!hasBinary("systemd-analyze")) {
        // Treat as a soft pass on non-systemd hosts; the unit is still
        // covered by the structural assertions in the `systemd unit` block.
        return;
      }
      const unitPath = join(deployDir, "systemd", "mcp-readonly-sql.service");
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

    it("docker build passes (skipped if docker not available or daemon not up)", () => {
      if (!hasBinary("docker") || !isDockerDaemonUp()) {
        // The Dockerfile is still covered by the structural assertions in
        // the `Dockerfile (task 3.2)` block; the operator verify command
        // is best-effort. CI / the operator runs the real `docker build`.
        return;
      }
      try {
        execFileSync(
          "docker",
          [
            "build",
            "-f",
            join(deployDir, "docker", "Dockerfile"),
            "-t",
            "mcp-readonly-sql-test",
            ".",
          ],
          {
            cwd: workspaceRoot,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 600_000, // 10 min — full pnpm install + build
          },
        );
      } catch (err) {
        const stderr =
          (err as { stderr?: Buffer | string }).stderr?.toString?.() ??
          String(err);
        throw new Error(`docker build failed: ${stderr}`);
      }
    });

    it("nginx -t passes against a cert-substituted copy (skipped if nginx or openssl not available)", () => {
      // The shipped mcp.conf references /etc/ssl/certs/mcp.crt which won't
      // exist on most test machines. We generate a self-signed cert + key
      // in a temp dir, copy the config there, substitute the paths, and
      // run `nginx -t -c <temp>.conf`. The test exercises the structural
      // correctness of the shipped config without baking a real cert into
      // the repo.
      if (!hasBinary("nginx") || !hasBinary("openssl")) {
        return;
      }
      const tempDir = mkdtempSync(join(tmpdir(), "mcp-nginx-"));
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

    it("runbook secret-grep returns zero matches (the spec's no-secrets lint)", () => {
      // Mirror the orchestrator's grep: no `eyJ`, no 64-char hex,
      // no `postgres://`, no `mysql://`. This is the same check the
      // structural test above performs, asserted here as a single
      // operator-side lint with explicit patterns.
      const readme = readDeployFile("README.md");
      const matches = [
        readme.match(/\beyJ[A-Za-z0-9_-]{10,}/g),
        readme.match(/\b[a-f0-9]{64}\b/g),
        readme.match(/postgres:\/\/[^"'\s]+/g),
        readme.match(/mysql:\/\/[^"'\s]+/g),
      ].flat().filter(Boolean);
      expect(matches, `runbook secret-grep matches: ${matches.join(" | ")}`).toEqual([]);
    });
  });
});
