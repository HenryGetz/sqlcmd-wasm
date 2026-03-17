/**
 * Supported high-level directives that can appear in the terminal input stream.
 */
export type ParsedLineAction =
  | { kind: 'sql'; text: string }
  | { kind: 'go'; count: number }
  | { kind: 'read-file'; requestedPath: string | null }
  | { kind: 'help'; topic: string | null }
  | { kind: 'intro' }
  | { kind: 'on-error'; mode: OnErrorMode }
  | { kind: 'clear-screen' }
  | { kind: 'wipe-state' }
  | { kind: 'reset' }
  | { kind: 'exit' }
  | { kind: 'setvar'; name: string; value: string }
  | { kind: 'listvar' }
  | { kind: 'invalid'; message: string };

/**
 * :On Error behavior mode.
 */
export type OnErrorMode = 'exit' | 'ignore';

/**
 * Expanded SQL batch plus any unresolved variables.
 */
export interface VariableExpansionResult {
  expandedSql: string;
  missingVariables: string[];
}

/**
 * In-memory query result representation that is easy to format in a terminal.
 */
export interface QueryResultSet {
  columns: string[];
  rows: string[][];
}

/**
 * Successful execution payload for a transpiled batch.
 */
export interface BatchExecutionSuccess {
  ok: true;
  translatedSql: string;
  resultSets: QueryResultSet[];
  rowsAffected: number;
  stateChanged: boolean;
}

/**
 * Failure payload with stage-specific metadata.
 */
export interface BatchExecutionFailure {
  ok: false;
  stage: 'transpile' | 'sqlite';
  rawError: string;
  lineNumber: number;
  token?: string;
}

/**
 * Result type returned from the execution engine.
 */
export type BatchExecutionResult = BatchExecutionSuccess | BatchExecutionFailure;
