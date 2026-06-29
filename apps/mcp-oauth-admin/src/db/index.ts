/**
 * Barrel for the database module. The schema + connection modules
 * are kept separate so the rest of the codebase can import them
 * individually; the barrel is the documented entry point.
 */
export {
  openDatabase,
  defaultDatabasePath,
  withSingleWriter,
  drainWriterChain,
  SQLITE_BUSY_RETRY_BUDGET,
  type AuthorityDatabase,
  type AuthorityTrx,
} from "./connection.js";
export { initializeSchema } from "./schema.js";
