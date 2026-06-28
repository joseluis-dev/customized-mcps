# syntax=docker/dockerfile:1.7
# =============================================================================
# mcp-readonly-sql — multi-stage production image
# =============================================================================
# Spec: apps/mcp-readonly-sql is a TypeScript ESM package. The build stage
# compiles src/ → dist/ via the workspace's pnpm install. The runtime stage
# is a minimal node:20-alpine image that runs the compiled dist/ as the
# unprivileged `node` user and exposes /healthz for the orchestrator probe.
#
# The image is intentionally language-agnostic at the spec level: a future
# Python MCP in apps/<py-app>/ can copy this Dockerfile and replace the
# `node:20-alpine` stages with `python:3.12-slim` while keeping the same
# user / workdir / healthcheck shape. See the mcp-deployment-templates
# spec → "Language-Agnostic Templates".
# =============================================================================

ARG NODE_VERSION=20-alpine

# -----------------------------------------------------------------------------
# Stage 1 — build
# -----------------------------------------------------------------------------
# Installs the full workspace deps (dev + prod) and compiles the TS source.
# `corepack enable` activates the pnpm version pinned in package.json
# ("packageManager": "pnpm@10.33.0") and avoids a global pnpm install.
FROM node:${NODE_VERSION} AS build
WORKDIR /workspace
ENV CI=true

# Enable pnpm via corepack so the build is reproducible across hosts.
RUN corepack enable

# Copy workspace manifests first for better layer caching. The pnpm
# filter installs only the deps the app needs (including its workspace
# dep on @customized-mcps/mcp-http-base).
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/mcp-http-base/package.json ./packages/mcp-http-base/
COPY apps/mcp-readonly-sql/package.json ./apps/mcp-readonly-sql/

# Install the full dep tree (dev + prod) for the build.
# --frozen-lockfile keeps CI honest about the lockfile.
RUN pnpm install --frozen-lockfile

# Copy the source trees for the packages the app depends on.
COPY packages/ ./packages/
COPY apps/ ./apps/

# Compile the app. Output: apps/mcp-readonly-sql/dist/
RUN pnpm --filter mcp-readonly-sql build

# Use `pnpm deploy` to produce a self-contained deploy tree at /deploy.
# This ships node_modules, the dist/ tree, and the package.json — but
# NOT src/ or test/, satisfying the spec's "no src/, no test/" rule.
# `--prod` keeps production-only deps; the runtime image never has the
# dev toolchain.
RUN pnpm --filter mcp-readonly-sql --prod deploy /deploy

# -----------------------------------------------------------------------------
# Stage 2 — runtime
# -----------------------------------------------------------------------------
# Minimal node:20-alpine with only the deploy tree. The `node` user ships
# with the official image (uid 1000, no shell) — see Dockerfile reference
# for node:alpine. We use it as-is; /healthz is unauthenticated, so the
# attack surface is small.
FROM node:${NODE_VERSION} AS runtime
LABEL org.opencontainers.image.title="mcp-readonly-sql" \
      org.opencontainers.image.description="Read-only MCP server for SQL databases (PostgreSQL, MySQL/MariaDB, SQL Server, SQLite). HTTP transport." \
      org.opencontainers.image.source="https://github.com/example/db" \
      org.opencontainers.image.licenses="ISC"

# `node:20-alpine` ships with a `node` user (uid 1000, no shell).
# We do NOT create a custom user; the upstream `node` user is the
# well-known non-root identity and matches the spec's
# "user has no shell" requirement.
USER node
WORKDIR /app

# Copy the self-contained deploy tree (node_modules + package.json + dist/).
COPY --from=build --chown=node:node /deploy /app

# Copy .env.example into the image for operator reference. The operator
# MUST mount their own .env (or pass --env-file); the image NEVER bakes
# secrets. `.env.example` is the single source of truth for env var names;
# see deploy/README.md → "Configuration: where env vars come from".
COPY --from=build --chown=node:node /workspace/apps/mcp-readonly-sql/.env.example /app/.env.example

# Default port (matches the app's MCP_HTTP_PORT default).
EXPOSE 3001

# HEALTHCHECK hits the unauthenticated /healthz endpoint exposed by the
# shared @customized-mcps/mcp-http-base. The inline node script exits 0 on 200, 1 on
# any other status or connection error. The probe is interval=30s with
# 3 retries — same cadence as the default Kubernetes liveness probe.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3001/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# Production-safe defaults. The operator can override any of these by
# mounting their own .env or by passing -e NAME=value. The defaults
# match the spec's "Loopback-Only Default" + "Production TLS Boundary"
# requirements: loopback bind, behind a reverse proxy, HTTP transport.
# These are the ONLY env vars set at build time; every other MCP_/DB_
# var MUST come from the operator's .env (or the reverse proxy).
ENV MCP_TRANSPORT=streamableHttp \
    MCP_HTTP_HOST=127.0.0.1 \
    MCP_HTTP_PORT=3001 \
    MCP_HTTP_BEHIND_PROXY=true

# Run as a long-lived server. The shared base installs SIGTERM/SIGINT
# handlers in start() and drains in-flight requests before exiting
# (see packages/mcp-http-base/src/shutdown.ts). PID 1 in the container
# receives the signal from `docker stop`, not from a terminal.
CMD ["node", "dist/index.js"]
