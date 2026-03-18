import type { CommandParser } from './CommandParser';
import { ErrorFormatter } from './ErrorFormatter';
import type { ExecutionEngine } from './ExecutionEngine';
import type { TerminalUI } from './TerminalUI';
import type {
  StartupDatabaseType,
  StartupSqlInput,
  StartupVariableAssignment,
  UrlStartupOptions,
} from './UrlStartupOptions';
import {
  type PersistedSessionOperation,
  PersistenceStore,
} from './PersistenceStore';
import { mapSqlCodeSegments } from './sqlTextUtils';
import { formatResultSetAsAsciiTable } from './formatters/tableFormatter';
import type { OnErrorMode } from './types';

type BufferedBatchOperation =
  | {
      kind: 'sql';
      lineNumber: number;
      sql: string;
      repeatCount: number;
    }
  | {
      kind: 'create-database';
      lineNumber: number;
      databaseName: string;
    }
  | {
      kind: 'use-database';
      lineNumber: number;
      databaseName: string;
    }
  | {
      kind: 'drop-database';
      lineNumber: number;
      databaseName: string;
    }
  | {
      kind: 'invalid-directive';
      lineNumber: number;
      message: string;
    };

interface DirectiveParseState {
  inBlockComment: boolean;
  inSingleQuote: boolean;
  inDoubleQuote: boolean;
  inBacktickQuote: boolean;
  inBracketIdentifier: boolean;
}

/**
 * Coordinates UI input, directive handling, buffering rules, and SQL execution.
 */
export class SqlCmdSession {
  private readonly bufferLines: string[] = [];
  private isDisconnected = false;
  private isExecuting = false;
  private isLoadingFile = false;
  private isBootstrapping = false;
  private onErrorMode: OnErrorMode = 'ignore';
  private activeDatabaseAlias: string | null = null;
  private isReplayingPersistedOperations = false;
  private persistenceWritesDisabled = false;
  private hasStarted = false;

  private readonly errorFormatter = new ErrorFormatter('WasmSQL');

  private readonly initialDirectiveParseState: DirectiveParseState = {
    inBlockComment: false,
    inSingleQuote: false,
    inDoubleQuote: false,
    inBacktickQuote: false,
    inBracketIdentifier: false,
  };

  public constructor(
    private readonly terminalUi: TerminalUI,
    private readonly parser: CommandParser,
    private readonly engine: ExecutionEngine,
    private readonly startupOptions: UrlStartupOptions,
    private readonly persistenceStore: PersistenceStore,
  ) {}

  /**
   * Exposed for headless automation so CLI tests can wait for settled prompts.
   */
  public isIdleForAutomation(): boolean {
    return (
      this.hasStarted &&
      !this.isDisconnected &&
      !this.isExecuting &&
      !this.isLoadingFile &&
      !this.isBootstrapping
    );
  }

  /**
   * Show intro banner and start accepting terminal lines.
   */
  public async start(): Promise<void> {
    this.terminalUi.writeLine('Microslop (R) SQL Server Command Line Tool');
    this.terminalUi.writeLine('Version 42.0.69.WASM NT');
    this.terminalUi.writeLine(
      'Copyright (C) 2026 Microslop Corporation. All rights (and your data) reserved.',
    );
    this.terminalUi.writeLine();
    this.terminalUi.writeLine(
      'Type SQL statements, then GO. Type :Help for help (:Intro for quick start).',
    );

    this.terminalUi.onLine(async (line) => {
      await this.handleLine(line);
    });

    await this.restorePersistedOperations();

    const alreadyRenderedPrompt = await this.applyUrlStartupOptions();

    if (!alreadyRenderedPrompt) {
      this.renderCurrentPrompt();
    }

    this.hasStarted = true;
  }

  private async restorePersistedOperations(): Promise<void> {
    let operations: PersistedSessionOperation[];

    try {
      operations = await this.persistenceStore.listOperations();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.terminalUi.writeInfo(
        `Persistence: Unable to read IndexedDB journal (${message}).`,
      );
      return;
    }

    if (operations.length === 0) {
      return;
    }

    this.terminalUi.writeInfo(
      `Persistence: Restoring ${operations.length} operation${operations.length === 1 ? '' : 's'} from IndexedDB...`,
    );

    this.isReplayingPersistedOperations = true;

    try {
      for (const operation of operations) {
        const restored = await this.replayPersistedOperation(operation);

        if (!restored) {
          this.terminalUi.writeError(
            'Persistence: Restore stopped after an operation failed. Use WIPE to clear persisted state.',
          );
          return;
        }
      }
    } finally {
      this.isReplayingPersistedOperations = false;
    }

    this.terminalUi.writeInfo('Persistence: Restore complete.');
  }

  private async replayPersistedOperation(
    operation: PersistedSessionOperation,
  ): Promise<boolean> {
    if (operation.kind === 'create-database') {
      return this.executeCreateDatabaseDirective(
        operation.databaseName,
        1,
        false,
      );
    }

    if (operation.kind === 'use-database') {
      return this.executeUseDatabaseDirective(operation.databaseName, 1, false);
    }

    if (operation.kind === 'drop-database') {
      return this.executeDropDatabaseDirective(
        operation.databaseName,
        1,
        false,
      );
    }

    const executionResult = this.engine.executeBatch(
      operation.sql,
      operation.repeatCount,
    );

    if (!executionResult.ok) {
      this.reportExecutionFailure(executionResult);
      return false;
    }

    return true;
  }

  private async persistOperation(
    operation: PersistedSessionOperation,
  ): Promise<void> {
    if (this.isReplayingPersistedOperations || this.persistenceWritesDisabled) {
      return;
    }

    try {
      await this.persistenceStore.appendOperation(operation);
    } catch (error) {
      this.persistenceWritesDisabled = true;
      const message = error instanceof Error ? error.message : String(error);
      this.terminalUi.writeInfo(`Persistence: Autosave disabled (${message}).`);
    }
  }

  private async wipeSessionState(): Promise<void> {
    this.bufferLines.length = 0;
    this.activeDatabaseAlias = null;
    this.engine.resetDatabase();

    try {
      await this.persistenceStore.clearOperations();
      this.persistenceWritesDisabled = false;
      this.terminalUi.writeInfo(
        'Session wiped: cleared in-memory database, buffer, and IndexedDB journal.',
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.reportClientError(
        `Session wiped in memory, but failed to clear IndexedDB journal: ${message}`,
        1,
      );
    }

    this.renderPromptIfActive();
  }

  private async applyUrlStartupOptions(): Promise<boolean> {
    for (const notice of this.startupOptions.notices) {
      this.terminalUi.writeInfo(`Startup: ${notice}`);
    }

    if (this.startupOptions.startupOnErrorMode) {
      this.onErrorMode = this.startupOptions.startupOnErrorMode;
      this.terminalUi.writeInfo(
        `Startup: :On Error mode set to ${this.onErrorMode.toUpperCase()}.`,
      );
    }

    const hasStartupActions =
      this.startupOptions.databaseSource !== null ||
      this.startupOptions.initScriptSource !== null ||
      this.startupOptions.sqlInputs.length > 0 ||
      this.startupOptions.startupVariables.length > 0 ||
      this.startupOptions.autoRun;

    if (!hasStartupActions) {
      return false;
    }

    this.isBootstrapping = true;
    this.terminalUi.setInputEnabled(false);

    try {
      if (this.startupOptions.databaseSource) {
        await this.loadStartupDatabase(
          this.startupOptions.databaseSource,
          this.startupOptions.databaseType,
        );

        if (this.isDisconnected) {
          return true;
        }
      }

      if (this.startupOptions.initScriptSource) {
        await this.loadAndExecuteStartupSqlScript(
          this.startupOptions.initScriptSource,
          'init',
        );

        if (this.isDisconnected) {
          return true;
        }
      }

      if (this.startupOptions.startupVariables.length > 0) {
        this.applyStartupVariableAssignments(
          this.startupOptions.startupVariables,
        );

        if (this.isDisconnected) {
          return true;
        }
      }

      if (this.startupOptions.sqlInputs.length > 0) {
        let totalPreloadedSqlLines = 0;

        for (const sqlInput of this.startupOptions.sqlInputs) {
          totalPreloadedSqlLines += await this.preloadStartupSqlInput(sqlInput);

          if (this.isDisconnected) {
            return true;
          }
        }

        this.terminalUi.writeInfo(
          `Startup: Preloaded ${totalPreloadedSqlLines} ${
            totalPreloadedSqlLines === 1 ? 'line' : 'lines'
          } of SQL from URL parameters.`,
        );
      }

      if (this.startupOptions.autoRun) {
        const hasExecutableSql = this.bufferLines.join('\n').trim().length > 0;

        if (!hasExecutableSql) {
          this.terminalUi.writeInfo(
            'Startup: Auto-run requested, but there is no SQL batch to execute.',
          );
          return false;
        }

        this.terminalUi.writeInfo(
          `Startup: Executing preloaded SQL automatically (GO ${this.startupOptions.autoRunCount}).`,
        );
        await this.executeBufferedBatch(this.startupOptions.autoRunCount);
        return true;
      }

      return false;
    } finally {
      this.isBootstrapping = false;

      if (!this.isDisconnected) {
        this.terminalUi.setInputEnabled(true);
      }
    }
  }

  private applyStartupVariableAssignments(
    assignments: StartupVariableAssignment[],
  ): void {
    for (const assignment of assignments) {
      this.parser.setVariable(assignment.name, assignment.value);
    }

    const assignedVariableNames = assignments.map(
      (assignment) => assignment.name,
    );
    const uniqueNames = [...new Set(assignedVariableNames)];
    const duplicateCount = assignedVariableNames.length - uniqueNames.length;

    this.terminalUi.writeInfo(
      `Startup: Assigned ${assignments.length} variable ${assignments.length === 1 ? 'value' : 'values'} via URL (${uniqueNames.join(', ')}${duplicateCount > 0 ? `, ${duplicateCount} override${duplicateCount === 1 ? '' : 's'}` : ''}).`,
    );
  }

  private async preloadStartupSqlInput(
    sqlInput: StartupSqlInput,
  ): Promise<number> {
    if (sqlInput.kind === 'inline') {
      return this.appendImportedTextToStatementCache(sqlInput.text);
    }

    return this.loadStartupSqlFromUrlToBuffer(
      sqlInput.source,
      sqlInput.parameter,
    );
  }

  private async loadStartupSqlFromUrlToBuffer(
    requestedSource: string,
    parameter: 'sqlUrl' | 'sqlFile',
  ): Promise<number> {
    this.terminalUi.writeInfo(
      `Startup: Loading SQL from ${parameter}=${requestedSource} ...`,
    );

    try {
      const resolvedUrl = this.resolveStartupResourceUrl(requestedSource);
      const sqlText = await this.fetchStartupResourceText(resolvedUrl);
      const loadedLineCount = this.appendImportedTextToStatementCache(sqlText);

      this.terminalUi.writeInfo(
        `Startup: Loaded ${loadedLineCount} ${loadedLineCount === 1 ? 'line' : 'lines'} from ${requestedSource}.`,
      );

      return loadedLineCount;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.reportClientError(
        `Startup SQL preload failed (${parameter}): ${message}`,
        1,
      );
      return 0;
    }
  }

  private async loadStartupDatabase(
    requestedSource: string,
    requestedType: StartupDatabaseType | null,
  ): Promise<void> {
    const inferredType =
      requestedType ?? this.inferStartupDatabaseType(requestedSource);

    if (inferredType === 'sql') {
      await this.loadAndExecuteStartupSqlScript(requestedSource, 'db');
      return;
    }

    this.terminalUi.writeInfo(
      `Startup: Loading SQLite database from ${requestedSource} ...`,
    );

    try {
      const resolvedUrl = this.resolveStartupResourceUrl(requestedSource);
      const bytes = await this.fetchStartupResourceBytes(resolvedUrl);
      this.engine.loadDatabaseFromBytes(bytes);
      // Replacing main DB invalidates any previously restored USE context.
      this.activeDatabaseAlias = null;
      this.terminalUi.writeInfo(
        `Startup: Loaded SQLite database from ${requestedSource} (${bytes.byteLength} bytes).`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.reportClientError(`Startup database load failed: ${message}`, 1);
    }
  }

  private async loadAndExecuteStartupSqlScript(
    requestedSource: string,
    sourceKind: 'db' | 'init',
  ): Promise<void> {
    this.terminalUi.writeInfo(
      `Startup: Loading SQLite SQL script from ${requestedSource} ...`,
    );

    try {
      const resolvedUrl = this.resolveStartupResourceUrl(requestedSource);
      const scriptText = await this.fetchStartupResourceText(resolvedUrl);
      const executionResult = this.engine.executeSqliteScript(scriptText);

      if (!executionResult.ok) {
        this.reportClientError(
          `Startup SQL script failed (${sourceKind}): ${executionResult.rawError}`,
          executionResult.lineNumber,
        );
        return;
      }

      this.terminalUi.writeInfo(
        `Startup: Executed SQLite SQL script from ${requestedSource} (${executionResult.rowsAffected} rows affected).`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.reportClientError(`Startup SQL script load failed: ${message}`, 1);
    }
  }

  private resolveStartupResourceUrl(requestedSource: string): string {
    return new URL(requestedSource, window.location.href).toString();
  }

  private inferStartupDatabaseType(
    requestedSource: string,
  ): StartupDatabaseType {
    const normalizedPath = requestedSource
      .split('?')[0]
      .split('#')[0]
      .toLowerCase();

    if (normalizedPath.endsWith('.sql') || normalizedPath.endsWith('.txt')) {
      return 'sql';
    }

    return 'binary';
  }

  private async fetchStartupResourceBytes(
    resourceUrl: string,
  ): Promise<Uint8Array> {
    const response = await fetch(resourceUrl);

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status} while requesting ${resourceUrl}`,
      );
    }

    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  }

  private async fetchStartupResourceText(resourceUrl: string): Promise<string> {
    const response = await fetch(resourceUrl);

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status} while requesting ${resourceUrl}`,
      );
    }

    const text = await response.text();

    if (this.looksLikeHtmlDocument(text)) {
      throw new Error(
        `Expected SQL text but received HTML from ${resourceUrl}. Check the path and static file mapping.`,
      );
    }

    return text;
  }

  private looksLikeHtmlDocument(text: string): boolean {
    const normalizedPrefix = text.slice(0, 512).trimStart().toLowerCase();

    return (
      normalizedPrefix.startsWith('<!doctype html') ||
      normalizedPrefix.startsWith('<html')
    );
  }

  private async handleLine(line: string): Promise<void> {
    if (this.isDisconnected) {
      return;
    }

    if (this.isExecuting || this.isLoadingFile || this.isBootstrapping) {
      this.reportClientError(
        'Execution already in progress. Please wait...',
        this.getCurrentBufferLine(),
      );
      this.renderPromptIfActive();
      return;
    }

    const action = this.parser.parseLine(line);

    switch (action.kind) {
      case 'invalid': {
        this.reportClientError(action.message, this.getCurrentBufferLine());
        this.renderPromptIfActive();
        return;
      }

      case 'reset': {
        this.bufferLines.length = 0;
        this.terminalUi.writeInfo('Batch buffer cleared.');
        this.renderPromptIfActive();
        return;
      }

      case 'wipe-state': {
        await this.wipeSessionState();
        return;
      }

      case 'exit': {
        this.isDisconnected = true;
        this.terminalUi.lockInput();
        this.terminalUi.writeInfo(
          'Sqlcmd: session terminated. Input is now disabled.',
        );
        return;
      }

      case 'setvar': {
        this.parser.setVariable(action.name, action.value);
        this.terminalUi.writeInfo(`Variable ${action.name} assigned.`);
        this.renderPromptIfActive();
        return;
      }

      case 'listvar': {
        this.renderVariables();
        this.renderPromptIfActive();
        return;
      }

      case 'go': {
        if (this.isInsideOpenDirectiveContext(this.bufferLines)) {
          this.bufferLines.push(line);
          this.renderPromptIfActive();
          return;
        }

        await this.executeBufferedBatch(action.count);
        return;
      }

      case 'on-error': {
        this.onErrorMode = action.mode;
        this.terminalUi.writeInfo(
          `:On Error mode set to ${action.mode.toUpperCase()}.`,
        );
        this.renderPromptIfActive();
        return;
      }

      case 'help': {
        this.renderHelpMenu(action.topic);
        this.renderPromptIfActive();
        return;
      }

      case 'intro': {
        this.renderIntroTutorial();
        this.renderPromptIfActive();
        return;
      }

      case 'clear-screen': {
        this.terminalUi.clearScreen();
        this.renderPromptIfActive();
        return;
      }

      case 'read-file': {
        await this.handleReadFileDirective(action.requestedPath);
        return;
      }

      case 'sql': {
        this.bufferLines.push(action.text);
        this.renderPromptIfActive();
      }
    }
  }

  /**
   * Implements a browser-native variant of sqlcmd's :r directive.
   */
  private async handleReadFileDirective(
    requestedPath: string | null,
  ): Promise<void> {
    this.isLoadingFile = true;
    this.terminalUi.setInputEnabled(false);

    try {
      if (requestedPath) {
        this.terminalUi.writeInfo(
          `Microslop VFS: :r ${requestedPath} requested. Select a local .sql/.txt file to import.`,
        );
      }

      const selectedFile = await this.showFilePickerForReadDirective();

      if (!selectedFile) {
        this.terminalUi.writeInfo(
          'Microslop VFS: File import canceled by user.',
        );
        this.renderPromptIfActive();
        return;
      }

      const fileText = await selectedFile.text();
      const importedLineCount =
        this.appendImportedTextToStatementCache(fileText);

      this.terminalUi.writeInfo(
        `Microslop VFS: Successfully loaded ${importedLineCount} ${
          importedLineCount === 1 ? 'line' : 'lines'
        } from ${selectedFile.name}`,
      );
      this.renderPromptIfActive();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.reportClientError(
        `Microslop VFS: Failed to import file: ${message}`,
        this.getCurrentBufferLine(),
      );
      this.renderPromptIfActive();
    } finally {
      this.isLoadingFile = false;
      this.terminalUi.setInputEnabled(true);
    }
  }

  /**
   * Prompt the user to choose a local SQL/TXT file and resolve with the file.
   */
  private async showFilePickerForReadDirective(): Promise<File | null> {
    const showOpenFilePicker = (
      window as Window & {
        showOpenFilePicker?: (
          options?: unknown,
        ) => Promise<Array<{ getFile: () => Promise<File> }>>;
      }
    ).showOpenFilePicker;

    if (typeof showOpenFilePicker === 'function') {
      try {
        const handles = await showOpenFilePicker.call(window, {
          multiple: false,
          types: [
            {
              description: 'SQL script files',
              accept: {
                'text/plain': ['.sql', '.txt'],
              },
            },
          ],
        });

        if (handles.length === 0) {
          return null;
        }

        return handles[0].getFile();
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return null;
        }
      }
    }

    return this.showFilePickerWithInputFallback();
  }

  private showFilePickerWithInputFallback(): Promise<File | null> {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = false;
      input.accept = '.sql,.txt';
      input.style.display = 'none';

      let settled = false;
      let didLoseFocusAfterOpen = false;
      let settleTimerId: number | null = null;

      const getSelectedFile = (): File | null =>
        input.files && input.files.length > 0 ? input.files[0] : null;

      const clearSettleTimer = (): void => {
        if (settleTimerId === null) {
          return;
        }

        window.clearTimeout(settleTimerId);
        settleTimerId = null;
      };

      const settleFromInputWhenStable = (maxWaitMs: number): void => {
        clearSettleTimer();
        const startedAt = Date.now();

        const poll = (): void => {
          if (settled) {
            return;
          }

          const selectedFile = getSelectedFile();
          if (selectedFile) {
            finish(selectedFile);
            return;
          }

          if (Date.now() - startedAt >= maxWaitMs) {
            finish(null);
            return;
          }

          settleTimerId = window.setTimeout(poll, 50);
        };

        settleTimerId = window.setTimeout(poll, 50);
      };

      const finish = (file: File | null): void => {
        if (settled) {
          return;
        }

        settled = true;
        cleanup();
        resolve(file);
      };

      const onChange = (): void => {
        clearSettleTimer();
        finish(getSelectedFile());
      };

      const onCancel = (): void => {
        // Some browsers emit cancel before the selected file is reflected.
        settleFromInputWhenStable(1000);
      };

      const onWindowBlur = (): void => {
        didLoseFocusAfterOpen = true;
      };

      const onWindowFocus = (): void => {
        // Only treat focus restoration as picker-close after we observed blur.
        if (!didLoseFocusAfterOpen) {
          return;
        }

        // Some browsers restore focus without change/cancel events.
        settleFromInputWhenStable(1200);
      };

      const cleanup = (): void => {
        clearSettleTimer();
        input.removeEventListener('change', onChange);
        input.removeEventListener('cancel', onCancel as EventListener);
        window.removeEventListener('blur', onWindowBlur);
        window.removeEventListener('focus', onWindowFocus);
        input.remove();
      };

      input.addEventListener('change', onChange);
      input.addEventListener('cancel', onCancel as EventListener);
      window.addEventListener('blur', onWindowBlur);
      window.addEventListener('focus', onWindowFocus);

      document.body.append(input);

      try {
        const maybeShowPicker = (
          input as HTMLInputElement & { showPicker?: () => void }
        ).showPicker;

        if (typeof maybeShowPicker === 'function') {
          maybeShowPicker.call(input);
        } else {
          input.click();
        }
      } catch {
        input.click();
      }
    });
  }

  /**
   * Append imported script text to the current statement cache and return line count.
   */
  private appendImportedTextToStatementCache(fileText: string): number {
    const normalized = fileText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    if (normalized.length === 0) {
      return 0;
    }

    const newlineCount = (normalized.match(/\n/g) ?? []).length;
    const lineCount = newlineCount + 1;
    const importedLines = normalized.split('\n');

    this.bufferLines.push(...importedLines);

    return lineCount;
  }

  private renderVariables(): void {
    const entries = this.parser.listVariables();

    if (entries.length === 0) {
      this.terminalUi.writeLine('(No variables defined)');
      return;
    }

    const nameWidth = Math.max(
      'Name'.length,
      ...entries.map(([name]) => name.length),
    );
    const valueWidth = Math.max(
      'Value'.length,
      ...entries.map(([, value]) => value.length),
    );

    const separator = `+${'-'.repeat(nameWidth + 2)}+${'-'.repeat(valueWidth + 2)}+`;
    const header = `| ${'Name'.padEnd(nameWidth, ' ')} | ${'Value'.padEnd(valueWidth, ' ')} |`;

    this.terminalUi.writeLine(separator);
    this.terminalUi.writeLine(header);
    this.terminalUi.writeLine(separator);

    for (const [name, value] of entries) {
      this.terminalUi.writeLine(
        `| ${name.padEnd(nameWidth, ' ')} | ${value.padEnd(valueWidth, ' ')} |`,
      );
    }

    this.terminalUi.writeLine(separator);
  }

  private renderHelpMenu(topic: string | null): void {
    if (topic) {
      this.terminalUi.writeInfo(
        `No detailed help available for '${topic}'. Showing general help.`,
      );
    }

    this.terminalUi.writeLine('SQLCMD Help');
    this.terminalUi.writeLine('----------');
    this.terminalUi.writeLine(
      'GO [count]               Execute the current statement cache.',
    );
    this.terminalUi.writeLine(
      'RESET                    Clear the current statement cache.',
    );
    this.terminalUi.writeLine(
      'WIPE | RESET ALL         Clear DB state + IndexedDB persistence + buffer.',
    );
    this.terminalUi.writeLine(
      'QUIT | EXIT              Terminate the session.',
    );
    this.terminalUi.writeLine(
      ':setvar Name value|"value" Define a scripting variable.',
    );
    this.terminalUi.writeLine(
      ':listvar                 List all scripting variables.',
    );
    this.terminalUi.writeLine(
      ':r [filename]            Load a local .sql/.txt file into the cache.',
    );
    this.terminalUi.writeLine(
      ':On Error [exit|ignore]  Choose whether errors end the session.',
    );
    this.terminalUi.writeLine(
      ':Intro                   Show a first-run tutorial in sqlcmd style.',
    );
    this.terminalUi.writeLine(
      ':Help                    Display this help menu.',
    );
    this.terminalUi.writeLine(
      '!! cls                   Clear terminal output (like cls).',
    );
  }

  private renderIntroTutorial(): void {
    this.terminalUi.writeLine('SQLCMD Intro');
    this.terminalUi.writeLine('------------');
    this.terminalUi.writeLine('Core Flow');
    this.terminalUi.writeLine('---------');
    this.terminalUi.writeLine('1) Type one or more SQL lines into the current batch.');
    this.terminalUi.writeLine('2) Type GO to execute the current batch.');
    this.terminalUi.writeLine('3) Type GO [count] to execute the same batch multiple times.');
    this.terminalUi.writeLine('4) Type RESET to clear pending lines without executing.');
    this.terminalUi.writeLine();

    this.terminalUi.writeLine('Useful Commands');
    this.terminalUi.writeLine('---------------');
    this.terminalUi.writeLine(':r [filename]            Import a local .sql/.txt file into the batch.');
    this.terminalUi.writeLine(':setvar Name value|"value" Define $(Name) variable values.');
    this.terminalUi.writeLine(':listvar                 Show currently defined variables.');
    this.terminalUi.writeLine(':On Error [exit|ignore]  Exit on first error, or continue.');
    this.terminalUi.writeLine('!! cls                   Clear terminal output.');
    this.terminalUi.writeLine('WIPE | RESET ALL         Reset DB state + persisted journal + batch.');
    this.terminalUi.writeLine();

    this.terminalUi.writeLine('Example Session');
    this.terminalUi.writeLine('---------------');
    this.terminalUi.writeLine('1> :setvar TableName "Users"');
    this.terminalUi.writeLine('1> CREATE TABLE $(TableName) (Id INT, Name VARCHAR(50));');
    this.terminalUi.writeLine('2> INSERT INTO $(TableName) VALUES (1, \'Ada\');');
    this.terminalUi.writeLine('3> GO');
    this.terminalUi.writeLine('1> SELECT * FROM $(TableName);');
    this.terminalUi.writeLine('2> GO');
    this.terminalUi.writeLine();

    this.terminalUi.writeLine('Type :Help for the complete command reference.');
  }

  private async executeBufferedBatch(goCount: number): Promise<void> {
    if (this.bufferLines.length === 0) {
      this.reportClientError(
        'Batch buffer is empty. Enter SQL lines before GO.',
        1,
      );
      this.renderPromptIfActive();
      return;
    }

    this.isExecuting = true;
    this.terminalUi.setInputEnabled(false);

    try {
      const bufferedSql = this.bufferLines.join('\n');
      const operations = this.parseBufferedBatchOperations(bufferedSql);

      if (operations.length === 0) {
        this.reportClientError(
          'Nothing to execute: this batch only contains blank lines. Type SQL before GO, or use RESET.',
          1,
        );
        if (!this.isDisconnected) {
          this.resetBufferAndPrompt();
        }
        return;
      }

      const allResultSets: Array<{ columns: string[]; rows: string[][] }> = [];
      let totalRowsAffected = 0;
      let executedSqlBatchCount = 0;

      for (let iteration = 1; iteration <= goCount; iteration += 1) {
        for (const operation of operations) {
          if (operation.kind === 'invalid-directive') {
            this.reportClientError(operation.message, operation.lineNumber);
            if (!this.isDisconnected) {
              this.resetBufferAndPrompt();
            }
            return;
          }

          if (operation.kind === 'create-database') {
            if (
              !(await this.executeCreateDatabaseDirective(
                operation.databaseName,
                operation.lineNumber,
              ))
            ) {
              if (!this.isDisconnected) {
                this.resetBufferAndPrompt();
              }
              return;
            }

            await this.persistOperation({
              kind: 'create-database',
              databaseName: operation.databaseName,
              createdAt: Date.now(),
            });
            continue;
          }

          if (operation.kind === 'use-database') {
            if (
              !(await this.executeUseDatabaseDirective(
                operation.databaseName,
                operation.lineNumber,
              ))
            ) {
              if (!this.isDisconnected) {
                this.resetBufferAndPrompt();
              }
              return;
            }

            await this.persistOperation({
              kind: 'use-database',
              databaseName: operation.databaseName,
              createdAt: Date.now(),
            });
            continue;
          }

          if (operation.kind === 'drop-database') {
            if (
              !(await this.executeDropDatabaseDirective(
                operation.databaseName,
                operation.lineNumber,
              ))
            ) {
              if (!this.isDisconnected) {
                this.resetBufferAndPrompt();
              }
              return;
            }

            await this.persistOperation({
              kind: 'drop-database',
              databaseName: operation.databaseName,
              createdAt: Date.now(),
            });
            continue;
          }

          const result = this.executeSqlOperation(operation);

          if (!result) {
            if (!this.isDisconnected) {
              this.resetBufferAndPrompt();
            }
            return;
          }

          allResultSets.push(...result.resultSets);
          totalRowsAffected += result.rowsAffected;
          executedSqlBatchCount += 1;

          if (result.stateChanged) {
            await this.persistOperation({
              kind: 'sql',
              sql: result.persistedSql,
              repeatCount: result.repeatCount,
              createdAt: Date.now(),
            });
          }
        }
      }

      if (allResultSets.length > 0) {
        for (let i = 0; i < allResultSets.length; i += 1) {
          const resultSet = allResultSets[i];
          const table = formatResultSetAsAsciiTable(resultSet);

          for (const tableLine of table.split('\n')) {
            this.terminalUi.writeLine(tableLine);
          }

          if (i < allResultSets.length - 1) {
            this.terminalUi.writeLine();
          }
        }
      }

      if (executedSqlBatchCount > 0) {
        this.terminalUi.writeLine(`(${totalRowsAffected} rows affected)`);
      } else {
        this.terminalUi.writeInfo('Commands completed successfully.');
      }

      this.resetBufferAndPrompt();
    } finally {
      this.isExecuting = false;
      this.terminalUi.setInputEnabled(true);
    }
  }

  private parseBufferedBatchOperations(
    batchSql: string,
  ): BufferedBatchOperation[] {
    const lines = batchSql
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .split('\n');
    const operations: BufferedBatchOperation[] = [];

    let currentSqlLines: string[] = [];
    let currentSqlStartLine = 1;
    let directiveParseState: DirectiveParseState = {
      ...this.initialDirectiveParseState,
    };

    const flushCurrentSqlLines = (repeatCount: number): void => {
      if (currentSqlLines.length === 0) {
        return;
      }

      const sql = currentSqlLines.join('\n');

      if (sql.trim().length > 0) {
        operations.push({
          kind: 'sql',
          lineNumber: currentSqlStartLine,
          sql,
          repeatCount,
        });
      }

      currentSqlLines = [];
    };

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const lineNumber = index + 1;
      const analyzedLine = this.analyzeLineForDirectiveParsing(
        line,
        directiveParseState,
      );

      directiveParseState = analyzedLine.nextState;

      const trimmed = analyzedLine.visibleText.trim();

      if (trimmed.length === 0) {
        if (currentSqlLines.length > 0) {
          currentSqlLines.push(line);
        }

        continue;
      }

      const goMatch = trimmed.match(/^GO(?:\s+(\d+))?\s*(?:--.*)?$/i);

      if (goMatch) {
        const repeatCount = goMatch[1] ? Number.parseInt(goMatch[1], 10) : 1;

        if (!Number.isSafeInteger(repeatCount) || repeatCount < 1) {
          operations.push({
            kind: 'invalid-directive',
            lineNumber,
            message: `Invalid GO count '${goMatch[1]}'. GO count must be a positive integer.`,
          });
        } else {
          flushCurrentSqlLines(repeatCount);
        }

        continue;
      }

      const createDatabaseMatch = trimmed.match(
        /^CREATE\s+DATABASE\s+(.+?)\s*;?\s*(?:--.*)?$/i,
      );

      if (createDatabaseMatch) {
        flushCurrentSqlLines(1);
        const databaseName = this.parseDatabaseAlias(createDatabaseMatch[1]);

        if (!databaseName) {
          operations.push({
            kind: 'invalid-directive',
            lineNumber,
            message:
              'Invalid CREATE DATABASE name. Use a simple identifier like CoffeeShopDB or [CoffeeShopDB].',
          });
        } else {
          operations.push({
            kind: 'create-database',
            lineNumber,
            databaseName,
          });
        }

        continue;
      }

      const useDatabaseMatch = trimmed.match(/^USE\s+(.+?)\s*;?\s*(?:--.*)?$/i);

      if (useDatabaseMatch) {
        flushCurrentSqlLines(1);
        const databaseName = this.parseDatabaseAlias(useDatabaseMatch[1]);

        if (!databaseName) {
          operations.push({
            kind: 'invalid-directive',
            lineNumber,
            message:
              'Invalid USE target. Use a simple identifier like CoffeeShopDB.',
          });
        } else {
          operations.push({
            kind: 'use-database',
            lineNumber,
            databaseName,
          });
        }

        continue;
      }

      const dropDatabaseMatch = trimmed.match(
        /^DROP\s+DATABASE\s+(.+?)\s*;?\s*(?:--.*)?$/i,
      );

      if (dropDatabaseMatch) {
        flushCurrentSqlLines(1);
        const databaseName = this.parseDatabaseAlias(dropDatabaseMatch[1]);

        if (!databaseName) {
          operations.push({
            kind: 'invalid-directive',
            lineNumber,
            message:
              'Invalid DROP DATABASE target. Use a simple identifier like CoffeeShopDB.',
          });
        } else {
          operations.push({
            kind: 'drop-database',
            lineNumber,
            databaseName,
          });
        }

        continue;
      }

      if (currentSqlLines.length === 0) {
        currentSqlStartLine = lineNumber;
      }

      currentSqlLines.push(line);
    }

    flushCurrentSqlLines(1);

    return operations;
  }

  private analyzeLineForDirectiveParsing(
    line: string,
    startingState: DirectiveParseState,
  ): {
    visibleText: string;
    nextState: DirectiveParseState;
  } {
    const state: DirectiveParseState = {
      ...startingState,
    };

    let visibleText = '';
    let index = 0;

    while (index < line.length) {
      const current = line[index];
      const next = line[index + 1] ?? '';

      if (state.inBlockComment) {
        if (current === '*' && next === '/') {
          state.inBlockComment = false;
          index += 2;
          continue;
        }

        index += 1;
        continue;
      }

      if (
        !state.inSingleQuote &&
        !state.inDoubleQuote &&
        !state.inBacktickQuote &&
        !state.inBracketIdentifier &&
        current === '/' &&
        next === '*'
      ) {
        state.inBlockComment = true;
        index += 2;
        continue;
      }

      if (
        !state.inSingleQuote &&
        !state.inDoubleQuote &&
        !state.inBacktickQuote &&
        !state.inBracketIdentifier &&
        current === '-' &&
        next === '-'
      ) {
        break;
      }

      if (!state.inDoubleQuote && !state.inBacktickQuote && !state.inBracketIdentifier) {
        if (current === "'" && next === "'") {
          visibleText += current;
          visibleText += next;
          index += 2;
          continue;
        }

        if (current === "'") {
          state.inSingleQuote = !state.inSingleQuote;
          visibleText += current;
          index += 1;
          continue;
        }
      }

      if (!state.inSingleQuote && !state.inBacktickQuote && !state.inBracketIdentifier) {
        if (current === '"' && next === '"') {
          visibleText += current;
          visibleText += next;
          index += 2;
          continue;
        }

        if (current === '"') {
          state.inDoubleQuote = !state.inDoubleQuote;
          visibleText += current;
          index += 1;
          continue;
        }
      }

      if (!state.inSingleQuote && !state.inDoubleQuote && !state.inBracketIdentifier) {
        if (current === '`' && next === '`') {
          visibleText += current;
          visibleText += next;
          index += 2;
          continue;
        }

        if (current === '`') {
          state.inBacktickQuote = !state.inBacktickQuote;
          visibleText += current;
          index += 1;
          continue;
        }
      }

      if (!state.inSingleQuote && !state.inDoubleQuote && !state.inBacktickQuote) {
        if (current === '[' && !state.inBracketIdentifier) {
          state.inBracketIdentifier = true;
          visibleText += current;
          index += 1;
          continue;
        }

        if (current === ']' && state.inBracketIdentifier) {
          if (next === ']') {
            visibleText += current;
            visibleText += next;
            index += 2;
            continue;
          }

          state.inBracketIdentifier = false;
          visibleText += current;
          index += 1;
          continue;
        }
      }

      visibleText += current;
      index += 1;
    }

    return {
      visibleText,
      nextState: state,
    };
  }

  private isInsideOpenDirectiveContext(lines: string[]): boolean {
    let state: DirectiveParseState = {
      ...this.initialDirectiveParseState,
    };

    for (const line of lines) {
      const analysis = this.analyzeLineForDirectiveParsing(line, state);
      state = analysis.nextState;
    }

    return (
      state.inBlockComment ||
      state.inSingleQuote ||
      state.inDoubleQuote ||
      state.inBacktickQuote ||
      state.inBracketIdentifier
    );
  }

  private parseDatabaseAlias(rawValue: string): string | null {
    let normalized = rawValue.trim();

    if (/^\[[^\]]+\]$/.test(normalized)) {
      normalized = normalized.slice(1, -1);
    } else if (/^"[^"]+"$/.test(normalized) || /^`[^`]+`$/.test(normalized)) {
      normalized = normalized.slice(1, -1);
    }

    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(normalized)) {
      return null;
    }

    if (/^(main|temp)$/i.test(normalized)) {
      return null;
    }

    return normalized;
  }

  private async executeCreateDatabaseDirective(
    databaseName: string,
    lineNumber: number,
    announce = true,
  ): Promise<boolean> {
    if (this.engine.hasAttachedDatabase(databaseName)) {
      this.reportClientError(
        `Database '${databaseName}' already exists in this session.`,
        lineNumber,
      );
      return false;
    }

    const attachResult = this.engine.executeSqliteScript(
      `ATTACH DATABASE ':memory:' AS ${databaseName};`,
    );

    if (!attachResult.ok) {
      this.reportClientError(
        `Failed to create database '${databaseName}': ${attachResult.rawError}`,
        lineNumber,
      );
      return false;
    }

    if (announce) {
      this.terminalUi.writeInfo(`Database '${databaseName}' created.`);
    }

    return true;
  }

  private async executeUseDatabaseDirective(
    databaseName: string,
    lineNumber: number,
    announce = true,
  ): Promise<boolean> {
    if (!this.engine.hasAttachedDatabase(databaseName)) {
      this.reportClientError(
        `Cannot USE database '${databaseName}' because it is not attached. Run CREATE DATABASE first.`,
        lineNumber,
      );
      return false;
    }

    this.activeDatabaseAlias = databaseName;

    if (announce) {
      this.terminalUi.writeInfo(
        `Changed database context to '${databaseName}'.`,
      );
    }

    return true;
  }

  private async executeDropDatabaseDirective(
    databaseName: string,
    lineNumber: number,
    announce = true,
  ): Promise<boolean> {
    if (!this.engine.hasAttachedDatabase(databaseName)) {
      this.reportClientError(
        `Cannot DROP database '${databaseName}' because it does not exist.`,
        lineNumber,
      );
      return false;
    }

    const detachResult = this.engine.executeSqliteScript(
      `DETACH DATABASE ${databaseName};`,
    );

    if (!detachResult.ok) {
      this.reportClientError(
        `Failed to drop database '${databaseName}': ${detachResult.rawError}`,
        lineNumber,
      );
      return false;
    }

    if (this.activeDatabaseAlias === databaseName) {
      this.activeDatabaseAlias = null;
    }

    if (announce) {
      this.terminalUi.writeInfo(`Database '${databaseName}' dropped.`);
    }

    return true;
  }

  private executeSqlOperation(
    operation: Extract<BufferedBatchOperation, { kind: 'sql' }>,
  ): {
    resultSets: Array<{ columns: string[]; rows: string[][] }>;
    rowsAffected: number;
    persistedSql: string;
    repeatCount: number;
    stateChanged: boolean;
  } | null {
    const expansion = this.parser.expandVariables(operation.sql);

    if (expansion.missingVariables.length > 0) {
      this.reportClientError(
        `Undefined scripting variable(s): ${expansion.missingVariables.join(', ')}`,
        operation.lineNumber,
      );
      return null;
    }

    const sqlWithContext = this.applyActiveDatabaseContext(expansion.expandedSql);

    const executionResult = this.engine.executeBatch(
      sqlWithContext,
      operation.repeatCount,
    );

    if (!executionResult.ok) {
      this.reportExecutionFailure(executionResult);
      return null;
    }

    return {
      resultSets: executionResult.resultSets,
      rowsAffected: executionResult.rowsAffected,
      persistedSql: sqlWithContext,
      repeatCount: operation.repeatCount,
      stateChanged: executionResult.stateChanged,
    };
  }

  private applyActiveDatabaseContext(sqlBatch: string): string {
    if (!this.activeDatabaseAlias) {
      return sqlBatch;
    }

    const activeAlias = this.activeDatabaseAlias;

    return mapSqlCodeSegments(sqlBatch, (code) => {
      let updated = code;
      const cteNames = this.extractCteNames(code);

      updated = this.qualifyKeywordTarget(
        updated,
        /(\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?)(\[[^\]]+\]|"[^"]+"|`[^`]+`|[A-Za-z_][A-Za-z0-9_]*)/gi,
        activeAlias,
        cteNames,
      );
      updated = this.qualifyKeywordTarget(
        updated,
        /(\bINSERT\s+INTO\s+)(\[[^\]]+\]|"[^"]+"|`[^`]+`|[A-Za-z_][A-Za-z0-9_]*)/gi,
        activeAlias,
        cteNames,
      );
      updated = this.qualifyKeywordTarget(
        updated,
        /(\bUPDATE\s+)(\[[^\]]+\]|"[^"]+"|`[^`]+`|[A-Za-z_][A-Za-z0-9_]*)/gi,
        activeAlias,
        cteNames,
      );
      updated = this.qualifyKeywordTarget(
        updated,
        /(\bDELETE\s+FROM\s+)(\[[^\]]+\]|"[^"]+"|`[^`]+`|[A-Za-z_][A-Za-z0-9_]*)/gi,
        activeAlias,
        cteNames,
      );
      updated = this.qualifyKeywordTarget(
        updated,
        /(\bFROM\s+)(\[[^\]]+\]|"[^"]+"|`[^`]+`|[A-Za-z_][A-Za-z0-9_]*)/gi,
        activeAlias,
        cteNames,
      );
      updated = this.qualifyKeywordTarget(
        updated,
        /(\bJOIN\s+)(\[[^\]]+\]|"[^"]+"|`[^`]+`|[A-Za-z_][A-Za-z0-9_]*)/gi,
        activeAlias,
        cteNames,
      );
      updated = this.qualifyKeywordTarget(
        updated,
        /(\bALTER\s+TABLE\s+)(\[[^\]]+\]|"[^"]+"|`[^`]+`|[A-Za-z_][A-Za-z0-9_]*)/gi,
        activeAlias,
        cteNames,
      );
      updated = this.qualifyKeywordTarget(
        updated,
        /(\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?)(\[[^\]]+\]|"[^"]+"|`[^`]+`|[A-Za-z_][A-Za-z0-9_]*)/gi,
        activeAlias,
        cteNames,
      );
      updated = this.qualifyKeywordTarget(
        updated,
        /(\bTRUNCATE\s+TABLE\s+)(\[[^\]]+\]|"[^"]+"|`[^`]+`|[A-Za-z_][A-Za-z0-9_]*)/gi,
        activeAlias,
        cteNames,
      );
      updated = this.qualifyKeywordTarget(
        updated,
        /(\bREFERENCES\s+)(\[[^\]]+\]|"[^"]+"|`[^`]+`|[A-Za-z_][A-Za-z0-9_]*)/gi,
        activeAlias,
        cteNames,
      );

      return updated;
    });
  }

  private qualifyKeywordTarget(
    sqlCode: string,
    pattern: RegExp,
    activeAlias: string,
    cteNames: ReadonlySet<string>,
  ): string {
    return sqlCode.replace(pattern, (match, prefix: string, identifier: string, offset: number) => {
      const identifierStart = offset + prefix.length;
      const identifierEnd = identifierStart + identifier.length;

      if (this.isIdentifierAlreadyQualified(sqlCode, identifierEnd)) {
        return match;
      }

      if (!this.shouldQualifyIdentifier(identifier, activeAlias, cteNames)) {
        return match;
      }

      return `${prefix}${activeAlias}.${identifier}`;
    });
  }

  private shouldQualifyIdentifier(
    identifierToken: string,
    activeAlias: string,
    cteNames: ReadonlySet<string>,
  ): boolean {
    const normalized = this.normalizeIdentifierToken(identifierToken);

    if (!normalized) {
      return false;
    }

    if (normalized.toLowerCase() === activeAlias.toLowerCase()) {
      return false;
    }

    if (cteNames.has(normalized.toLowerCase())) {
      return false;
    }

    if (
      normalized.toLowerCase() === 'sqlite_master' ||
      normalized.toLowerCase() === 'sqlite_schema'
    ) {
      return true;
    }

    const upper = normalized.toUpperCase();

    // Keywords are not table identifiers and should never be schema-qualified.
    if (
      upper === 'SELECT' ||
      upper === 'VALUES' ||
      upper === 'WHERE' ||
      upper === 'GROUP' ||
      upper === 'ORDER' ||
      upper === 'LIMIT' ||
      upper === 'OFFSET' ||
      upper === 'JOIN' ||
      upper === 'INNER' ||
      upper === 'LEFT' ||
      upper === 'RIGHT' ||
      upper === 'FULL' ||
      upper === 'CROSS' ||
      upper === 'UNION' ||
      upper === 'EXCEPT' ||
      upper === 'INTERSECT' ||
      upper === 'ON' ||
      upper === 'USING' ||
      upper === 'AS'
    ) {
      return false;
    }

    return true;
  }

  private extractCteNames(sqlCode: string): Set<string> {
    const names = new Set<string>();
    const withPattern = /\bWITH\b/gi;
    let withMatch: RegExpExecArray | null;

    while ((withMatch = withPattern.exec(sqlCode)) !== null) {
      let cursor = withMatch.index + withMatch[0].length;

      while (cursor < sqlCode.length) {
        const identifierMatch = sqlCode
          .slice(cursor)
          .match(/^\s*(\[[^\]]+\]|"[^"]+"|`[^`]+`|[A-Za-z_][A-Za-z0-9_]*)/);

        if (!identifierMatch) {
          break;
        }

        const identifierToken = identifierMatch[1];
        const normalizedIdentifier = this.normalizeIdentifierToken(identifierToken);

        if (!normalizedIdentifier) {
          break;
        }

        names.add(normalizedIdentifier.toLowerCase());
        cursor += identifierMatch[0].length;

        const columnListMatch = sqlCode.slice(cursor).match(/^\s*\([^)]*\)/);

        if (columnListMatch) {
          cursor += columnListMatch[0].length;
        }

        const asMatch = sqlCode.slice(cursor).match(/^\s+AS\s*\(/i);

        if (!asMatch) {
          names.delete(normalizedIdentifier.toLowerCase());
          break;
        }

        cursor += asMatch[0].length;
        let depth = 1;

        while (cursor < sqlCode.length && depth > 0) {
          const character = sqlCode[cursor];

          if (character === '(') {
            depth += 1;
          } else if (character === ')') {
            depth -= 1;
          }

          cursor += 1;
        }

        if (depth !== 0) {
          break;
        }

        const commaMatch = sqlCode.slice(cursor).match(/^\s*,/);

        if (commaMatch) {
          cursor += commaMatch[0].length;
          continue;
        }

        break;
      }
    }

    return names;
  }

  private normalizeIdentifierToken(token: string): string | null {
    const trimmed = token.trim();

    if (/^\[[^\]]+\]$/.test(trimmed)) {
      return trimmed.slice(1, -1).replace(/\]\]/g, ']');
    }

    if (/^"[^"]+"$/.test(trimmed)) {
      return trimmed.slice(1, -1).replace(/""/g, '"');
    }

    if (/^`[^`]+`$/.test(trimmed)) {
      return trimmed.slice(1, -1).replace(/``/g, '`');
    }

    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
      return trimmed;
    }

    return null;
  }

  private isIdentifierAlreadyQualified(
    sqlCode: string,
    identifierEnd: number,
  ): boolean {
    let cursor = identifierEnd;

    while (cursor < sqlCode.length && /\s/.test(sqlCode[cursor])) {
      cursor += 1;
    }

    return sqlCode[cursor] === '.';
  }

  private resetBufferAndPrompt(): void {
    this.bufferLines.length = 0;
    this.renderPromptIfActive();
  }

  private renderCurrentPrompt(): void {
    const promptNumber = this.bufferLines.length + 1;
    this.terminalUi.renderPrompt(promptNumber);
  }

  private reportExecutionFailure(failure: {
    stage: 'transpile' | 'sqlite';
    rawError: string;
    lineNumber: number;
    token?: string;
  }): void {
    const lines = this.errorFormatter.formatExecutionFailure({
      ok: false,
      stage: failure.stage,
      rawError: failure.rawError,
      lineNumber: failure.lineNumber,
      token: failure.token,
    });

    for (const line of lines) {
      this.terminalUi.writeError(line);
    }

    this.terminateSessionIfConfiguredToExit();
  }

  private reportClientError(message: string, lineNumber: number): void {
    const lines = this.errorFormatter.formatClientError(message, lineNumber);

    for (const line of lines) {
      this.terminalUi.writeError(line);
    }

    this.terminateSessionIfConfiguredToExit();
  }

  private terminateSessionIfConfiguredToExit(): void {
    if (this.onErrorMode !== 'exit') {
      return;
    }

    this.isDisconnected = true;
    this.terminalUi.lockInput();
    this.terminalUi.writeInfo(
      'Sqlcmd: :On Error EXIT triggered. Session terminated.',
    );
  }

  private getCurrentBufferLine(): number {
    return this.bufferLines.length + 1;
  }

  private renderPromptIfActive(): void {
    if (this.isDisconnected) {
      return;
    }

    this.renderCurrentPrompt();
  }
}
