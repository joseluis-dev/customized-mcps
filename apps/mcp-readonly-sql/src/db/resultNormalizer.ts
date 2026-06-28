import type { Knex } from "knex";
import type { QueryResult } from "../types.js";

export async function runReadQuery(
  trx: Knex,
  sql: string,
  bindings: ReadonlyArray<unknown> | Record<string, unknown>,
  maxRows: number,
): Promise<QueryResult> {
  const start = Date.now();
  const runner = Array.isArray(bindings)
    ? trx.raw(sql, bindings as ReadonlyArray<Knex.RawBinding>)
    : trx.raw(sql, bindings as Knex.ValueDict);
  const result = (await Promise.race([
    runner,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Query execution timed out")), 30_000),
    ),
  ])) as Knex.Raw<unknown[]>;
  const executionMs = Date.now() - start;

  const raw = result as unknown as {
    rows?: unknown[];
    [key: string]: unknown;
  };
  let allRows: Record<string, unknown>[] = [];
  if (Array.isArray(raw.rows)) {
    allRows = raw.rows as Record<string, unknown>[];
  } else if (Array.isArray((raw as unknown as { _: unknown })._)) {
    allRows = (raw as unknown as { _: Record<string, unknown>[] })._ ?? [];
  } else if (Array.isArray(result)) {
    allRows = result as unknown as Record<string, unknown>[];
  } else if (Array.isArray((result as unknown as { response: unknown }).response)) {
    allRows = (result as unknown as { response: Record<string, unknown>[] }).response;
  }

  const truncated = allRows.length > maxRows;
  const rows = truncated ? allRows.slice(0, maxRows) : allRows;
  const fields = extractFields(allRows);
  return {
    rows,
    rowCount: rows.length,
    truncated,
    fields,
    executionMs,
  };
}

function extractFields(rows: Record<string, unknown>[]): { name: string }[] {
  if (rows.length === 0) return [];
  const first = rows[0] ?? {};
  if (Array.isArray(first)) {
    return (first as unknown[]).map((_, i) => ({ name: `col_${i}` }));
  }
  if (typeof first === "object" && first !== null) {
    return Object.keys(first as object).map((name) => ({ name }));
  }
  return [];
}

export function normalizeBindings(
  bindings: unknown,
): ReadonlyArray<unknown> | Record<string, unknown> {
  if (bindings === undefined || bindings === null) return [];
  if (Array.isArray(bindings)) return bindings;
  if (typeof bindings === "object") return bindings as Record<string, unknown>;
  return [];
}
