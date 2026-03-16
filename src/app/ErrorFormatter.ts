import type { BatchExecutionFailure } from './types';

interface SqlServerStyleError {
  errorCode: number;
  level: number;
  state: number;
  serverName: string;
  lineNumber: number;
  message: string;
}

/**
 * Maps browser/WASM errors into SQL Server-style error output.
 */
export class ErrorFormatter {
  public constructor(private readonly serverName = 'WasmSQL') {}

  /**
   * Convert execution failures into SQL Server-like two-line error output.
   */
  public formatExecutionFailure(failure: BatchExecutionFailure): string[] {
    if (failure.stage === 'transpile') {
      return this.render(this.mapTranspileFailure(failure));
    }

    return this.render(this.mapSQLiteFailure(failure));
  }

  /**
   * Convert client-side directive problems into SQL Server-like output.
   */
  public formatClientError(message: string, lineNumber: number): string[] {
    return this.render({
      errorCode: 50000,
      level: 16,
      state: 1,
      serverName: this.serverName,
      lineNumber: this.normalizeLineNumber(lineNumber),
      message,
    });
  }

  private mapTranspileFailure(failure: BatchExecutionFailure): SqlServerStyleError {
    const token = failure.token?.trim();

    return {
      errorCode: 102,
      level: 15,
      state: 1,
      serverName: this.serverName,
      lineNumber: this.normalizeLineNumber(failure.lineNumber),
      message:
        token && token.length > 0
          ? `Incorrect syntax near '${token}'.`
          : this.isPlainSyntaxFallback(failure.rawError)
            ? 'Incorrect syntax.'
            : 'Incorrect syntax.',
    };
  }

  private mapSQLiteFailure(failure: BatchExecutionFailure): SqlServerStyleError {
    const raw = failure.rawError;

    const missingTableMatch = raw.match(/no such table:\s*([^\n]+)/i);
    if (missingTableMatch) {
      const objectName = this.sanitizeIdentifier(missingTableMatch[1]);

      return {
        errorCode: 208,
        level: 16,
        state: 1,
        serverName: this.serverName,
        lineNumber: this.normalizeLineNumber(failure.lineNumber),
        message: `Invalid object name '${objectName}'.`,
      };
    }

    const missingColumnMatch = raw.match(/no such column:\s*([^\n]+)/i);
    if (missingColumnMatch) {
      const columnName = this.sanitizeIdentifier(missingColumnMatch[1]);

      return {
        errorCode: 207,
        level: 16,
        state: 1,
        serverName: this.serverName,
        lineNumber: this.normalizeLineNumber(failure.lineNumber),
        message: `Invalid column name '${columnName}'.`,
      };
    }

    if (/constraint failed/i.test(raw)) {
      return {
        errorCode: 2627,
        level: 14,
        state: 1,
        serverName: this.serverName,
        lineNumber: this.normalizeLineNumber(failure.lineNumber),
        message: 'Violation of PRIMARY KEY constraint.',
      };
    }

    return {
      errorCode: 50000,
      level: 16,
      state: 1,
      serverName: this.serverName,
      lineNumber: this.normalizeLineNumber(failure.lineNumber),
      message: raw,
    };
  }

  private render(error: SqlServerStyleError): string[] {
    return [
      `Msg ${error.errorCode}, Level ${error.level}, State ${error.state}, Server ${error.serverName}, Line ${error.lineNumber}`,
      error.message,
    ];
  }

  private normalizeLineNumber(lineNumber: number): number {
    return Number.isFinite(lineNumber) && lineNumber >= 1 ? Math.floor(lineNumber) : 1;
  }

  private sanitizeIdentifier(value: string): string {
    return value.trim().replace(/^['"`\[]+/, '').replace(/['"`\]]+$/, '');
  }

  private isPlainSyntaxFallback(rawError: string): boolean {
    return /parse|syntax|unexpected/i.test(rawError);
  }
}
