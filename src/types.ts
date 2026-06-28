export type SupportedDialect = "postgres" | "mysql" | "mariadb" | "sqlite" | "mssql";

export type Profile = {
  name: string;
  dialect: SupportedDialect;
  client: string;
  connection: KnexConnectionConfig;
  knexOptions: Record<string, unknown>;
  scope: "server" | "database";
  initialDatabase: string;
  allowedDatabases: string[] | "all";
  requireQualifiedDatabase: boolean;
};

export type KnexConnectionConfig =
  | {
      kind: "postgres";
      host: string;
      port: number;
      database: string;
      user: string;
      password: string;
      ssl: boolean;
    }
  | {
      kind: "mysql";
      host: string;
      port: number;
      database: string;
      user: string;
      password: string;
    }
  | {
      kind: "sqlite";
      filename: string;
    }
  | {
      kind: "mssql";
      host: string;
      port: number;
      database: string;
      user: string;
      password: string;
      encrypt: boolean;
      trustServerCertificate: boolean;
    };

export type ProfileSummary = {
  name: string;
  dialect: SupportedDialect;
  scope: "server" | "database";
  allowedDatabases: string[] | "all";
  requireQualifiedDatabase: boolean;
};

export type QueryResult = {
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  fields: { name: string }[];
  executionMs: number;
};

export type SafetyLimits = {
  maxRowsDefault: number;
  maxRowsHardLimit: number;
  queryTimeoutMsDefault: number;
  queryTimeoutMsHardLimit: number;
};
