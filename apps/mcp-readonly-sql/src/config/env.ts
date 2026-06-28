import "dotenv/config";

function readString(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer`);
  }
  return n;
}

function readBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

export type RawEnv = {
  profileNames: string[];
  raw: Record<string, string | undefined>;
};

export function loadRawEnv(): RawEnv {
  const list = readString("DB_PROFILES", "");
  const names = list
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    profileNames: names,
    raw: { ...process.env },
  };
}

export function readSafetyLimits(): {
  maxRowsDefault: number;
  maxRowsHardLimit: number;
  queryTimeoutMsDefault: number;
  queryTimeoutMsHardLimit: number;
} {
  return {
    maxRowsDefault: readInt("MAX_ROWS_DEFAULT", 100),
    maxRowsHardLimit: readInt("MAX_ROWS_HARD_LIMIT", 1000),
    queryTimeoutMsDefault: readInt("QUERY_TIMEOUT_MS_DEFAULT", 10_000),
    queryTimeoutMsHardLimit: readInt("QUERY_TIMEOUT_MS_HARD_LIMIT", 60_000),
  };
}

export function readOptionalString(name: string): string | undefined {
  const v = process.env[name];
  if (v === undefined || v === "") return undefined;
  return v;
}

export { readString, readInt, readBool };
