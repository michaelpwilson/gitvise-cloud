import { GitViseError } from '@gitvise/core';

/**
 * D1 passthrough for the apps/api Drizzle transport (`apps/api/src/database/d1/gateway-d1.transport.ts` in the gitvise
 * repo). Every statement runs through the D1 binding, and results come back positionally, as `rows: unknown[][]`.
 */

export const D1_METHODS = ['run', 'all', 'values', 'get'] as const;
export type D1Method = (typeof D1_METHODS)[number];

export interface D1WireStatement {
  readonly sql: string;
  readonly params: readonly (string | number | null)[];
  readonly method: D1Method;
}

export interface D1QueryResponse {
  readonly rows: unknown[][];
}

/** Validates one wire statement. Booleans are bound as 0 and 1, since D1 has no boolean type. */
export function parseStatement(value: unknown): D1WireStatement {
  if (typeof value !== 'object' || value === null) {
    throw new GitViseError('INVALID_REQUEST', 'each statement must be an object');
  }
  const statement = value as { sql?: unknown; params?: unknown; method?: unknown };
  if (typeof statement.sql !== 'string' || statement.sql.trim() === '') {
    throw new GitViseError('INVALID_REQUEST', 'statement sql must be a non-empty string');
  }
  if (!(D1_METHODS as readonly unknown[]).includes(statement.method)) {
    throw new GitViseError('INVALID_REQUEST', 'statement method must be run, all, values, or get');
  }
  if (!Array.isArray(statement.params)) {
    throw new GitViseError('INVALID_REQUEST', 'statement params must be an array');
  }
  const params = statement.params.map((param: unknown): string | number | null => {
    if (param === null) return null;
    if (typeof param === 'string') return param;
    if (typeof param === 'boolean') return param ? 1 : 0;
    if (typeof param === 'number' && Number.isFinite(param)) return param;
    throw new GitViseError('INVALID_REQUEST', 'statement params must be strings, finite numbers, booleans, or null');
  });
  return { sql: statement.sql, params, method: statement.method as D1Method };
}

/** Runs one statement. `run` returns no rows, `get` keeps the first row, and `all` and `values` return every row. */
export async function runQuery(db: D1Database, statement: D1WireStatement): Promise<D1QueryResponse> {
  const prepared = db.prepare(statement.sql).bind(...statement.params);
  if (statement.method === 'run') {
    await prepared.run();
    return { rows: [] };
  }
  const rows = (await prepared.raw()) as unknown[][];
  return { rows: statement.method === 'get' ? rows.slice(0, 1) : rows };
}

/**
 * Runs the statements as one `db.batch`, which D1 applies atomically. The batch must not be split, so a failure
 * anywhere rolls the whole batch back. `batch` returns objects, not positional arrays, so each row is re-read in
 * column order with `Object.values`. That order is the SELECT order, except for integer-like column names, which
 * the callers do not use.
 */
export async function runBatch(
  db: D1Database,
  statements: readonly D1WireStatement[],
): Promise<{ results: D1QueryResponse[] }> {
  const prepared = statements.map((statement) => db.prepare(statement.sql).bind(...statement.params));
  const outcomes = await db.batch(prepared);
  return {
    results: outcomes.map((outcome, index) => {
      const method = statements[index]?.method ?? 'all';
      if (method === 'run') return { rows: [] };
      const rows = (outcome.results as Record<string, unknown>[]).map((row) => Object.values(row));
      return { rows: method === 'get' ? rows.slice(0, 1) : rows };
    }),
  };
}

export interface ConstraintFailure {
  /** The SQLite constraint name, for example `SQLITE_CONSTRAINT_UNIQUE`. Apps/api maps these to SQLSTATEs. */
  readonly code: string;
  readonly message: string;
}

/**
 * Recognises a SQLite constraint violation in a D1 error. D1 does not expose extended result codes, so the name is
 * read from the message or cause text. A message can say `SQLITE_CONSTRAINT_UNIQUE` outright, or only
 * `UNIQUE constraint failed`. Anything else returns undefined, and the caller rethrows it.
 */
export function constraintFailure(error: unknown): ConstraintFailure | undefined {
  const text = errorText(error);
  const message = text.trim();
  // Most specific first: an extended name, then a phrase, then the bare base name.
  const explicit = /SQLITE_CONSTRAINT_[A-Z]+/.exec(text);
  if (explicit !== null) return { code: explicit[0], message };
  const phrased = /\b(UNIQUE|PRIMARY KEY|FOREIGN KEY|NOT NULL|CHECK) constraint failed/i.exec(text);
  if (phrased !== null) {
    return { code: CONSTRAINT_PHRASES[phrased[1]?.toUpperCase() ?? ''] ?? 'SQLITE_CONSTRAINT', message };
  }
  if (/SQLITE_CONSTRAINT/.test(text)) return { code: 'SQLITE_CONSTRAINT', message };
  return undefined;
}

const CONSTRAINT_PHRASES: Readonly<Record<string, string>> = {
  UNIQUE: 'SQLITE_CONSTRAINT_UNIQUE',
  'PRIMARY KEY': 'SQLITE_CONSTRAINT_PRIMARYKEY',
  'FOREIGN KEY': 'SQLITE_CONSTRAINT_FOREIGNKEY',
  'NOT NULL': 'SQLITE_CONSTRAINT_NOTNULL',
  CHECK: 'SQLITE_CONSTRAINT_CHECK',
};

/** Joins the message of an error and of its causes, so a constraint named only in the cause is still found. */
function errorText(error: unknown, depth = 0): string {
  if (depth > 4 || error === null || error === undefined) return '';
  if (typeof error === 'string') return error;
  if (typeof error !== 'object') return '';
  const record = error as { message?: unknown; cause?: unknown };
  const message = typeof record.message === 'string' ? record.message : '';
  return `${message} ${errorText(record.cause, depth + 1)}`;
}
