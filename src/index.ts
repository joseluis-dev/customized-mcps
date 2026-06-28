import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadRawEnv, readSafetyLimits } from "./config/env.js";
import { loadAllProfiles, ProfileError } from "./config/profiles.js";
import { ConnectionManager } from "./db/knexFactory.js";
import { registerReadOnlyTools } from "./tools/readonlyTools.js";
import { sanitizeError } from "./security/sanitizeError.js";

function log(line: string): void {
  process.stderr.write(`[mcp-readonly-sql] ${line}\n`);
}

export async function runServer(): Promise<void> {
  const { profileNames, raw } = loadRawEnv();
  let profiles;
  try {
    profiles = loadAllProfiles(profileNames, raw);
  } catch (e) {
    if (e instanceof ProfileError) {
      log(`Profile configuration error: ${e.message}`);
    } else {
      const { message } = sanitizeError(e);
      log(`Profile configuration error: ${message}`);
    }
    process.exit(2);
  }

  if (profiles.length === 0) {
    log("No DB_PROFILES configured. The server will start but no profile will be available.");
  } else {
    log(`Loaded ${profiles.length} profile(s): ${profiles.map((p) => p.name).join(", ")}`);
  }

  const limits = readSafetyLimits();
  const connections = new ConnectionManager();

  const server = new McpServer({
    name: "mcp-readonly-sql",
    version: "0.1.0",
  });

  registerReadOnlyTools(server, { profiles, limits, connections });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("Server connected over stdio");

  const shutdown = async (): Promise<void> => {
    log("Shutting down...");
    await connections.destroyAll();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

runServer().catch((e) => {
  const { message } = sanitizeError(e);
  log(`Fatal error: ${message}`);
  process.exit(1);
});
