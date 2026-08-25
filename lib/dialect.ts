/**
 * Everything that differs per database engine lives here: the query that lists
 * user tables, and the reshaping of each driver's raw response.
 */

export const SUPPORTED_DIALECTS = [
  "postgresql",
  "redshift",
  "mysql",
  "sqlite3",
  "mssql",
  "oracle",
] as const

export type SupportedDialect = (typeof SUPPORTED_DIALECTS)[number]

export function toSupportedDialect(dialect: string): SupportedDialect | null {
  return SUPPORTED_DIALECTS.find((known) => known === dialect) ?? null
}

export type TableQuery = {
  readonly sql: string
  readonly bindings: readonly string[]
}

/**
 * Lists base tables in the schema knex writes to. The column name differs by
 * engine (`table_name` vs `TABLE_NAME`), so callers read the first string value
 * of each row instead of a fixed key.
 */
export function userTablesQuery(dialect: SupportedDialect, schemaName: string | null): TableQuery {
  switch (dialect) {
    case "postgresql":
    case "redshift":
      return schemaName === null
        ? {
            sql: "select table_name from information_schema.tables where table_schema = current_schema() and table_type = 'BASE TABLE'",
            bindings: [],
          }
        : {
            sql: "select table_name from information_schema.tables where table_schema = ? and table_type = 'BASE TABLE'",
            bindings: [schemaName],
          }
    case "mysql":
      return schemaName === null
        ? {
            sql: "select table_name from information_schema.tables where table_schema = database() and table_type = 'BASE TABLE'",
            bindings: [],
          }
        : {
            sql: "select table_name from information_schema.tables where table_schema = ? and table_type = 'BASE TABLE'",
            bindings: [schemaName],
          }
    case "sqlite3":
      return {
        sql: "select name from sqlite_master where type = 'table' and name not like 'sqlite_%'",
        bindings: [],
      }
    case "mssql":
      return schemaName === null
        ? {
            sql: "select TABLE_NAME from INFORMATION_SCHEMA.TABLES where TABLE_TYPE = 'BASE TABLE' and TABLE_SCHEMA = schema_name()",
            bindings: [],
          }
        : {
            sql: "select TABLE_NAME from INFORMATION_SCHEMA.TABLES where TABLE_TYPE = 'BASE TABLE' and TABLE_SCHEMA = ?",
            bindings: [schemaName],
          }
    case "oracle":
      return { sql: "select table_name from user_tables", bindings: [] }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Normalizes a raw driver response to a row list. PostgreSQL and Oracle return
 * `{ rows }`, MSSQL returns `{ recordset }`, MySQL returns `[rows, fields]`,
 * and SQLite returns the rows directly.
 */
export function rowsOf(response: unknown): readonly Record<string, unknown>[] {
  if (Array.isArray(response)) {
    const first: unknown = response[0]
    if (Array.isArray(first)) return first.filter(isRecord)
    return response.filter(isRecord)
  }
  if (isRecord(response)) {
    const rows: unknown = response["rows"] ?? response["recordset"]
    if (Array.isArray(rows)) return rows.filter(isRecord)
  }
  return []
}

/** Reads the table name without depending on the column's letter case. */
export function firstStringValue(row: Record<string, unknown>): string | null {
  for (const value of Object.values(row)) {
    if (typeof value === "string") return value
  }
  return null
}
