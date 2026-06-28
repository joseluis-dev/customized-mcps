import nodeSqlParser from "node-sql-parser";
import type { SupportedDialect } from "../types.js";
import { parserDialectFor } from "../db/dialects.js";

export class SqlGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SqlGuardError";
  }
}

const FORBIDDEN_STATEMENTS = new Set<string>([
  "insert",
  "update",
  "delete",
  "replace",
  "merge",
  "upsert",
  "drop",
  "alter",
  "create",
  "truncate",
  "grant",
  "revoke",
  "call",
  "exec",
  "do",
  "copy",
  "load",
  "use",
  "set",
  "reset",
  "begin",
  "commit",
  "rollback",
  "savepoint",
  "lock",
  "unlock",
  "rename",
]);

const FORBIDDEN_KEYWORDS = [
  /\binsert\b/i,
  /\bupdate\b/i,
  /\bdelete\b/i,
  /\bdrop\b/i,
  /\balter\b/i,
  /\bcreate\b/i,
  /\btruncate\b/i,
  /\bgrant\b/i,
  /\brevoke\b/i,
  /\bcall\b/i,
  /\bexec\b/i,
  /\bmerge\b/i,
  /\bupsert\b/i,
  /\binto\s+outfile\b/i,
  /\binto\s+dumpfile\b/i,
];

const parserCache = new Map<string, ParserInstance>();

type ParserInstance = {
  astify: (sql: string, opts?: Record<string, unknown>) => unknown;
  parse?: (sql: string, opts?: Record<string, unknown>) => {
    tableList?: string[];
    columnList?: string[];
    ast?: unknown;
  };
};

function getParser(dialect: SupportedDialect): ParserInstance {
  const cached = parserCache.get(dialect);
  if (cached) return cached;
  const ns = nodeSqlParser as unknown as { Parser: new () => ParserInstance };
  const p = new ns.Parser();
  parserCache.set(dialect, p);
  return p;
}

function stripCommentsAndStrings(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/#.*$/gm, " ")
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/"(?:""|[^"])*"/g, '""')
    .replace(/`(?:``|[^`])*`/g, "``");
}

function checkForbiddenKeywords(rawSql: string): void {
  for (const re of FORBIDDEN_KEYWORDS) {
    if (re.test(rawSql)) {
      const match = re.exec(rawSql);
      throw new SqlGuardError(
        `Forbidden SQL keyword detected: ${match?.[0] ?? re.source}`,
      );
    }
  }
}

function ensureSingleStatement(sql: string): void {
  const cleaned = stripCommentsAndStrings(sql).trim();
  if (cleaned.endsWith(";")) {
    const without = cleaned.slice(0, -1).trim();
    if (without.includes(";")) {
      throw new SqlGuardError("Multiple statements are not allowed");
    }
    return;
  }
  if (cleaned.includes(";")) {
    throw new SqlGuardError("Multiple statements are not allowed");
  }
}

type AstNode = { type?: string; ast?: AstNode | AstNode[] };

function collectStatementTypes(ast: AstNode | AstNode[]): string[] {
  const list: string[] = [];
  const visit = (node: AstNode | AstNode[] | undefined): void => {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const n of node) visit(n);
      return;
    }
    if (typeof node.type === "string") {
      list.push(node.type.toLowerCase());
    }
  };
  visit(ast);
  return list;
}

type TableRef = { database: string | null; schema: string | null; table: string };

function parseTableRef(entry: string): TableRef {
  const parts = entry.split("::");
  const table = parts[parts.length - 1] ?? "";
  const middle = (parts[parts.length - 2] ?? "").replace(/^null::?/, "");
  if (middle === "" || middle === "null") {
    return { database: null, schema: null, table };
  }
  const pieces = middle.split(".");
  if (pieces.length === 1) {
    return { database: pieces[0] ?? null, schema: null, table };
  }
  return {
    database: pieces[0] ?? null,
    schema: pieces[1] ?? null,
    table,
  };
}

export type DatabasePolicy = {
  allowed: string[] | "all";
  requireQualified: boolean;
};

export function extractTables(dialect: SupportedDialect, sql: string): TableRef[] {
  const parser = getParser(dialect);
  if (!parser.parse) {
    try {
      const ast = parser.astify(sql, { database: parserDialectFor(dialect) });
      const types = collectStatementTypes(ast as AstNode);
      if (types.length === 1 && (types[0] === "select" || types[0] === "with")) {
        const root: AstNode = (ast as { ast?: AstNode | AstNode[] }).ast
          ? ((ast as { ast: AstNode | AstNode[] }).ast as AstNode)
          : (ast as AstNode);
        const refs: TableRef[] = [];
        const seen = new Set<string>();
        const visit = (n: unknown): void => {
          if (!n || typeof n !== "object") return;
          const node = n as Record<string, unknown>;
          if (typeof node.table === "string" && typeof (node as { type?: string }).type === "string") {
            const t = (node as { type?: string }).type as string;
            if (t === "from" || t === "join" || t === "table_ref" || t === "table" || t === "update" || t === "into") {
              const dbVal = (node as { db?: unknown }).db;
              const schemaVal = (node as { schema?: unknown }).schema;
              const tableName = node.table as string;
              const database = typeof dbVal === "string" ? dbVal : null;
              const schema = typeof schemaVal === "string" ? schemaVal : null;
              const key = `${database ?? ""}.${schema ?? ""}.${tableName}`;
              if (!seen.has(key)) {
                seen.add(key);
                refs.push({ database, schema, table: tableName });
              }
            }
          }
          for (const k of Object.keys(node)) {
            const v = (node as Record<string, unknown>)[k];
            if (k === "parent" || k === "loc") continue;
            if (v && typeof v === "object") visit(v);
          }
        };
        visit(root);
        return refs;
      }
    } catch {
      return [];
    }
  }
  try {
    const parserWithParse = parser as Required<ParserInstance>;
    const result = parserWithParse.parse(sql, { database: parserDialectFor(dialect) });
    const list = result.tableList ?? [];
    const refs: TableRef[] = [];
    const seen = new Set<string>();
    for (const entry of list) {
      const ref = parseTableRef(entry);
      const key = `${ref.database ?? ""}.${ref.schema ?? ""}.${ref.table}`;
      if (!seen.has(key)) {
        seen.add(key);
        refs.push(ref);
      }
    }
    return refs;
  } catch {
    return [];
  }
}

function assertDatabasePolicy(
  dialect: SupportedDialect,
  sql: string,
  policy: DatabasePolicy | undefined,
): void {
  if (!policy) return;
  if (policy.allowed === "all" && !policy.requireQualified) return;
  const tables = extractTables(dialect, sql);
  if (tables.length === 0) return;
  for (const t of tables) {
    if (t.database === null) {
      if (policy.requireQualified) {
        throw new SqlGuardError(
          `Table "${t.table}" is not qualified with a database; this profile requires fully-qualified table names`,
        );
      }
      continue;
    }
    if (policy.allowed !== "all" && !policy.allowed.includes(t.database)) {
      throw new SqlGuardError(
        `Database "${t.database}" is not allowed by this profile's allowlist`,
      );
    }
  }
}

function assertReadOnlyAst(dialect: SupportedDialect, sql: string): void {
  const parser = getParser(dialect);
  let ast: unknown;
  try {
    ast = parser.astify(sql, { database: parserDialectFor(dialect) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new SqlGuardError(`SQL could not be parsed safely: ${msg}`);
  }

  const types = collectStatementTypes(ast as AstNode);

  if (types.length === 0) {
    throw new SqlGuardError("No parseable SQL statement found");
  }
  if (types.length > 1) {
    throw new SqlGuardError("Multiple statements are not allowed");
  }

  const top = types[0] ?? "";
  if (top === "select") return;
  if (top === "with") {
    const withNode = (ast as { ast?: AstNode | AstNode[] }).ast;
    const inner = collectStatementTypes(withNode ?? []);
    if (inner.length !== 1 || inner[0] !== "select") {
      throw new SqlGuardError("WITH clauses must resolve to a single SELECT");
    }
    return;
  }

  if (FORBIDDEN_STATEMENTS.has(top)) {
    throw new SqlGuardError(`Statement type "${top}" is not allowed`);
  }
  throw new SqlGuardError(`Statement type "${top}" is not allowed`);
}

export function assertReadOnlySql(
  dialect: SupportedDialect,
  sql: string,
  policy?: DatabasePolicy,
): void {
  if (typeof sql !== "string") {
    throw new SqlGuardError("SQL must be a string");
  }
  const trimmed = sql.trim();
  if (trimmed.length === 0) {
    throw new SqlGuardError("SQL is empty");
  }
  if (trimmed.length > 100_000) {
    throw new SqlGuardError("SQL is too long");
  }
  ensureSingleStatement(trimmed);
  checkForbiddenKeywords(trimmed);
  assertReadOnlyAst(dialect, trimmed);
  if (policy) {
    assertDatabasePolicy(dialect, trimmed, policy);
  }
}

export function _internalsForTest() {
  return {
    stripCommentsAndStrings,
    ensureSingleStatement,
    checkForbiddenKeywords,
    extractTables,
    parseTableRef,
  };
}
