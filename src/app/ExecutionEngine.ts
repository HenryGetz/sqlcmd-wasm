import { Dialect, transpile } from '@polyglot-sql/sdk';
import initSqlJs, { type Database, type Statement } from 'sql.js';
import sqlWasmUrl from 'sql.js/dist/sql-wasm.wasm?url';

import type { BatchExecutionResult, QueryResultSet } from './types';

interface SingleRunSuccess {
  ok: true;
  resultSets: QueryResultSet[];
  rowsAffected: number;
}

interface SingleRunFailure {
  ok: false;
  rawError: string;
  lineNumber: number;
}

type SingleRunResult = SingleRunSuccess | SingleRunFailure;

/**
 * Owns transpilation + SQLite execution responsibilities.
 */
export class ExecutionEngine {
  private constructor(private readonly db: Database) {}

  /**
   * Create and initialize the in-browser SQLite instance.
   */
  public static async initialize(): Promise<ExecutionEngine> {
    const SQL = await initSqlJs({
      locateFile: () => sqlWasmUrl,
    });

    const db = new SQL.Database();
    return new ExecutionEngine(db);
  }

  /**
   * Transpile T-SQL to SQLite SQL, then execute it one or many times.
   */
  public executeBatch(tsqlBatch: string, repeatCount: number): BatchExecutionResult {
    let transpileResult:
      | {
          success: true;
          sql?: string[];
        }
      | {
          success: false;
          error?: string;
          errorLine?: number;
          errorColumn?: number;
        };

    try {
      transpileResult = transpile(tsqlBatch, Dialect.TSQL, Dialect.SQLite);
    } catch (error) {
      const rawError = this.extractErrorMessage(error);
      const lineNumber = this.extractLineNumberFromMessage(rawError) ?? 1;
      const token = this.extractTokenFromSource(tsqlBatch, lineNumber);

      return {
        ok: false,
        stage: 'transpile',
        rawError,
        lineNumber,
        token,
      };
    }

    if (!transpileResult.success) {
      const rawError = transpileResult.error ?? 'Unknown transpilation error.';
      const lineNumber = transpileResult.errorLine ?? this.extractLineNumberFromMessage(rawError) ?? 1;
      const token = this.extractTokenFromSource(tsqlBatch, lineNumber, transpileResult.errorColumn);

      return {
        ok: false,
        stage: 'transpile',
        rawError,
        lineNumber,
        token,
      };
    }

    const translatedStatements = (transpileResult.sql ?? [])
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);

    const sourceStatementStartLines = this.computeSourceStatementStartLines(tsqlBatch);

    const translatedSql = translatedStatements
      .map((statement) => statement.replace(/;\s*$/, ''))
      .join(';\n');

    if (translatedSql.length === 0) {
      return {
        ok: false,
        stage: 'transpile',
        rawError:
          'No executable SQL was generated from this batch. Check for blank input, comments-only input, or unsupported T-SQL constructs.',
        lineNumber: 1,
      };
    }
    const allResultSets: QueryResultSet[] = [];
    let totalRowsAffected = 0;

    for (let iteration = 1; iteration <= repeatCount; iteration += 1) {
      const runResult = this.executeTranslatedBatch(translatedStatements, sourceStatementStartLines);
      if (!runResult.ok) {
        return {
          ok: false,
          stage: 'sqlite',
          rawError:
            repeatCount > 1
              ? `Iteration ${iteration}: ${runResult.rawError}`
              : runResult.rawError,
          lineNumber: runResult.lineNumber,
        };
      }

      allResultSets.push(...runResult.resultSets);
      totalRowsAffected += runResult.rowsAffected;
    }

    return {
      ok: true,
      translatedSql,
      resultSets: allResultSets,
      rowsAffected: totalRowsAffected,
    };
  }

  /**
   * Execute transpiled SQLite statements and gather result sets from SELECTs.
   */
  private executeTranslatedBatch(
    translatedStatements: string[],
    sourceStatementStartLines: number[],
  ): SingleRunResult {
    const resultSets: QueryResultSet[] = [];
    let dmlRowsAffected = 0;

    for (let statementIndex = 0; statementIndex < translatedStatements.length; statementIndex += 1) {
      const statementSql = translatedStatements[statementIndex];
      const fallbackLine = sourceStatementStartLines[statementIndex] ?? 1;

      try {
        const statementIterator = this.db.iterateStatements(statementSql);

        for (const statement of statementIterator) {
          const statementOutcome = this.executeStatement(statement);

          if (statementOutcome.columns.length > 0) {
            resultSets.push({
              columns: statementOutcome.columns,
              rows: statementOutcome.rows,
            });
          }

          if (statementOutcome.rowsModified > 0) {
            dmlRowsAffected += statementOutcome.rowsModified;
          }
        }
      } catch (error) {
        const rawError = this.extractErrorMessage(error);

        return {
          ok: false,
          rawError,
          lineNumber: this.extractLineNumberFromMessage(rawError) ?? fallbackLine,
        };
      }
    }

    const selectedRows = resultSets.reduce((count, resultSet) => count + resultSet.rows.length, 0);

    return {
      ok: true,
      resultSets,
      // sqlcmd commonly reports returned rows for SELECT-only runs.
      rowsAffected: selectedRows > 0 ? selectedRows : dmlRowsAffected,
    };
  }

  /**
   * Run a single prepared statement and normalize cells into string values.
   */
  private executeStatement(statement: Statement): {
    columns: string[];
    rows: string[][];
    rowsModified: number;
  } {
    const columns = statement.getColumnNames();
    const rows: string[][] = [];

    try {
      while (statement.step()) {
        const values = statement.get();
        rows.push(values.map((value) => this.stringifySqlValue(value)));
      }
    } finally {
      statement.free();
    }

    const rowsModified = this.db.getRowsModified();
    return { columns, rows, rowsModified };
  }

  /**
   * Convert SQLite return values to terminal-safe strings.
   */
  private stringifySqlValue(value: unknown): string {
    if (value === null) {
      return 'NULL';
    }

    if (value === undefined) {
      return '';
    }

    if (value instanceof Uint8Array) {
      // Display blobs in hexadecimal form for human readability.
      return `0x${[...value].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
    }

    return String(value);
  }

  private extractErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }

  /**
   * Best-effort extraction of line numbers exposed in toolchain errors.
   */
  private extractLineNumberFromMessage(message: string): number | null {
    const lineMatch = message.match(/\bline\s+(\d+)\b/i);
    if (!lineMatch) {
      return null;
    }

    const parsed = Number.parseInt(lineMatch[1], 10);
    return Number.isFinite(parsed) && parsed >= 1 ? parsed : null;
  }

  /**
   * Derive a failing token from source SQL when the parser can only provide coordinates.
   */
  private extractTokenFromSource(sourceSql: string, lineNumber: number, columnNumber?: number): string | undefined {
    const lines = sourceSql.split(/\r?\n/);
    const sourceLine = lines[lineNumber - 1];

    if (!sourceLine) {
      return undefined;
    }

    const zeroBasedColumn = Math.max(0, (columnNumber ?? 1) - 1);
    const fromColumn = sourceLine.slice(zeroBasedColumn);
    const tokenMatch = fromColumn.match(/^[A-Za-z_][A-Za-z0-9_]*|^[^\sA-Za-z0-9_]/);

    if (tokenMatch?.[0]) {
      return tokenMatch[0];
    }

    const firstTokenMatch = sourceLine.trim().match(/^[A-Za-z_][A-Za-z0-9_]*|^[^\sA-Za-z0-9_]/);
    return firstTokenMatch?.[0];
  }

  /**
   * Estimate the source line for each semicolon-terminated statement.
   */
  private computeSourceStatementStartLines(sourceSql: string): number[] {
    const startLines: number[] = [];

    let line = 1;
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let statementHasContent = false;
    let statementStartLine = 1;

    for (let i = 0; i < sourceSql.length; i += 1) {
      const char = sourceSql[i];

      if (char === '\n') {
        line += 1;
        continue;
      }

      if (char === "'" && !inDoubleQuote) {
        inSingleQuote = !inSingleQuote;
      } else if (char === '"' && !inSingleQuote) {
        inDoubleQuote = !inDoubleQuote;
      }

      if (!statementHasContent && !/\s/.test(char)) {
        statementHasContent = true;
        statementStartLine = line;
      }

      if (!inSingleQuote && !inDoubleQuote && char === ';') {
        if (statementHasContent) {
          startLines.push(statementStartLine);
          statementHasContent = false;
        }
      }
    }

    if (statementHasContent) {
      startLines.push(statementStartLine);
    }

    return startLines.length > 0 ? startLines : [1];
  }
}
