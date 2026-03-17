import { CommandParser } from './CommandParser';
import { ErrorFormatter } from './ErrorFormatter';
import { ExecutionEngine } from './ExecutionEngine';
import { TerminalUI } from './TerminalUI';
import type {
  StartupDatabaseType,
  StartupSqlInput,
  StartupVariableAssignment,
  UrlStartupOptions,
} from './UrlStartupOptions';
import { formatResultSetAsAsciiTable } from './formatters/tableFormatter';
import type { OnErrorMode } from './types';

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

  private readonly errorFormatter = new ErrorFormatter('WasmSQL');

  public constructor(
    private readonly terminalUi: TerminalUI,
    private readonly parser: CommandParser,
    private readonly engine: ExecutionEngine,
    private readonly startupOptions: UrlStartupOptions,
  ) {}

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
    this.terminalUi.writeLine('Type GO to execute batch, RESET to clear cache, and QUIT/EXIT to disconnect.');

    this.terminalUi.onLine(async (line) => {
      await this.handleLine(line);
    });

    const alreadyRenderedPrompt = await this.applyUrlStartupOptions();

    if (!alreadyRenderedPrompt) {
      this.renderCurrentPrompt();
    }
  }

  private async applyUrlStartupOptions(): Promise<boolean> {
    for (const notice of this.startupOptions.notices) {
      this.terminalUi.writeInfo(`Startup: ${notice}`);
    }

    if (this.startupOptions.startupOnErrorMode) {
      this.onErrorMode = this.startupOptions.startupOnErrorMode;
      this.terminalUi.writeInfo(`Startup: :On Error mode set to ${this.onErrorMode.toUpperCase()}.`);
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
        await this.loadAndExecuteStartupSqlScript(this.startupOptions.initScriptSource, 'init');

        if (this.isDisconnected) {
          return true;
        }
      }

      if (this.startupOptions.startupVariables.length > 0) {
        this.applyStartupVariableAssignments(this.startupOptions.startupVariables);

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
          this.terminalUi.writeInfo('Startup: Auto-run requested, but there is no SQL batch to execute.');
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

  private applyStartupVariableAssignments(assignments: StartupVariableAssignment[]): void {
    for (const assignment of assignments) {
      this.parser.setVariable(assignment.name, assignment.value);
    }

    const assignedVariableNames = assignments.map((assignment) => assignment.name);
    const uniqueNames = [...new Set(assignedVariableNames)];
    const duplicateCount = assignedVariableNames.length - uniqueNames.length;

    this.terminalUi.writeInfo(
      `Startup: Assigned ${assignments.length} variable ${assignments.length === 1 ? 'value' : 'values'} via URL (${uniqueNames.join(', ')}${duplicateCount > 0 ? `, ${duplicateCount} override${duplicateCount === 1 ? '' : 's'}` : ''}).`,
    );
  }

  private async preloadStartupSqlInput(sqlInput: StartupSqlInput): Promise<number> {
    if (sqlInput.kind === 'inline') {
      return this.appendImportedTextToStatementCache(sqlInput.text);
    }

    return this.loadStartupSqlFromUrlToBuffer(sqlInput.source, sqlInput.parameter);
  }

  private async loadStartupSqlFromUrlToBuffer(
    requestedSource: string,
    parameter: 'sqlUrl' | 'sqlFile',
  ): Promise<number> {
    this.terminalUi.writeInfo(`Startup: Loading SQL from ${parameter}=${requestedSource} ...`);

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
      this.reportClientError(`Startup SQL preload failed (${parameter}): ${message}`, 1);
      return 0;
    }
  }

  private async loadStartupDatabase(
    requestedSource: string,
    requestedType: StartupDatabaseType | null,
  ): Promise<void> {
    const inferredType = requestedType ?? this.inferStartupDatabaseType(requestedSource);

    if (inferredType === 'sql') {
      await this.loadAndExecuteStartupSqlScript(requestedSource, 'db');
      return;
    }

    this.terminalUi.writeInfo(`Startup: Loading SQLite database from ${requestedSource} ...`);

    try {
      const resolvedUrl = this.resolveStartupResourceUrl(requestedSource);
      const bytes = await this.fetchStartupResourceBytes(resolvedUrl);
      this.engine.loadDatabaseFromBytes(bytes);
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
    this.terminalUi.writeInfo(`Startup: Loading SQLite SQL script from ${requestedSource} ...`);

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

  private inferStartupDatabaseType(requestedSource: string): StartupDatabaseType {
    const normalizedPath = requestedSource.split('?')[0].split('#')[0].toLowerCase();

    if (normalizedPath.endsWith('.sql') || normalizedPath.endsWith('.txt')) {
      return 'sql';
    }

    return 'binary';
  }

  private async fetchStartupResourceBytes(resourceUrl: string): Promise<Uint8Array> {
    const response = await fetch(resourceUrl);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} while requesting ${resourceUrl}`);
    }

    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  }

  private async fetchStartupResourceText(resourceUrl: string): Promise<string> {
    const response = await fetch(resourceUrl);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} while requesting ${resourceUrl}`);
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

    return normalizedPrefix.startsWith('<!doctype html') || normalizedPrefix.startsWith('<html');
  }

  private async handleLine(line: string): Promise<void> {
    if (this.isDisconnected) {
      return;
    }

    if (this.isExecuting || this.isLoadingFile || this.isBootstrapping) {
      this.reportClientError('Execution already in progress. Please wait...', this.getCurrentBufferLine());
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

      case 'exit': {
        this.isDisconnected = true;
        this.terminalUi.lockInput();
        this.terminalUi.writeInfo('Sqlcmd: session terminated. Input is now disabled.');
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
        await this.executeBufferedBatch(action.count);
        return;
      }

      case 'on-error': {
        this.onErrorMode = action.mode;
        this.terminalUi.writeInfo(`:On Error mode set to ${action.mode.toUpperCase()}.`);
        this.renderPromptIfActive();
        return;
      }

      case 'help': {
        this.renderHelpMenu(action.topic);
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
  private async handleReadFileDirective(requestedPath: string | null): Promise<void> {
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
        this.terminalUi.writeInfo('Microslop VFS: File import canceled by user.');
        this.renderPromptIfActive();
        return;
      }

      const fileText = await selectedFile.text();
      const importedLineCount = this.appendImportedTextToStatementCache(fileText);

      this.terminalUi.writeInfo(
        `Microslop VFS: Successfully loaded ${importedLineCount} ${
          importedLineCount === 1 ? 'line' : 'lines'
        } from ${selectedFile.name}`,
      );
      this.renderPromptIfActive();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.reportClientError(`Microslop VFS: Failed to import file: ${message}`, this.getCurrentBufferLine());
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
        showOpenFilePicker?: (options?: unknown) => Promise<Array<{ getFile: () => Promise<File> }>>;
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
        const maybeShowPicker = (input as HTMLInputElement & { showPicker?: () => void }).showPicker;

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

    const nameWidth = Math.max('Name'.length, ...entries.map(([name]) => name.length));
    const valueWidth = Math.max('Value'.length, ...entries.map(([, value]) => value.length));

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
      this.terminalUi.writeInfo(`No detailed help available for '${topic}'. Showing general help.`);
    }

    this.terminalUi.writeLine('SQLCMD Help');
    this.terminalUi.writeLine('----------');
    this.terminalUi.writeLine('GO [count]               Execute the current statement cache.');
    this.terminalUi.writeLine('RESET                    Clear the current statement cache.');
    this.terminalUi.writeLine('QUIT | EXIT              Terminate the session.');
    this.terminalUi.writeLine(':setvar Name "value"     Define a scripting variable.');
    this.terminalUi.writeLine(':listvar                 List all scripting variables.');
    this.terminalUi.writeLine(':r [filename]            Load a local .sql/.txt file into the cache.');
    this.terminalUi.writeLine(':On Error [exit|ignore]  Choose whether errors end the session.');
    this.terminalUi.writeLine(':Help                    Display this help menu.');
    this.terminalUi.writeLine('!! cls                   Clear terminal output (like cls).');
  }

  private async executeBufferedBatch(goCount: number): Promise<void> {
    if (this.bufferLines.length === 0) {
      this.reportClientError('Batch buffer is empty. Enter SQL lines before GO.', 1);
      this.renderPromptIfActive();
      return;
    }

    this.isExecuting = true;
    this.terminalUi.setInputEnabled(false);

    try {
      const bufferedSql = this.bufferLines.join('\n');

      if (bufferedSql.trim().length === 0) {
        this.reportClientError(
          'Nothing to execute: this batch only contains blank lines. Type SQL before GO, or use RESET.',
          1,
        );
        if (!this.isDisconnected) {
          this.resetBufferAndPrompt();
        }
        return;
      }

      const expansion = this.parser.expandVariables(bufferedSql);

      if (expansion.missingVariables.length > 0) {
        this.reportClientError(
          `Undefined scripting variable(s): ${expansion.missingVariables.join(', ')}`,
          1,
        );
        if (!this.isDisconnected) {
          this.resetBufferAndPrompt();
        }
        return;
      }

      const executionResult = this.engine.executeBatch(expansion.expandedSql, goCount);

      if (!executionResult.ok) {
        this.reportExecutionFailure(executionResult);
        if (!this.isDisconnected) {
          this.resetBufferAndPrompt();
        }
        return;
      }

      if (executionResult.resultSets.length > 0) {
        for (let i = 0; i < executionResult.resultSets.length; i += 1) {
          const resultSet = executionResult.resultSets[i];
          const table = formatResultSetAsAsciiTable(resultSet);

          for (const tableLine of table.split('\n')) {
            this.terminalUi.writeLine(tableLine);
          }

          if (i < executionResult.resultSets.length - 1) {
            this.terminalUi.writeLine();
          }
        }
      }

      this.terminalUi.writeLine(`(${executionResult.rowsAffected} rows affected)`);
      this.resetBufferAndPrompt();
    } finally {
      this.isExecuting = false;
      this.terminalUi.setInputEnabled(true);
    }
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
    this.terminalUi.writeInfo('Sqlcmd: :On Error EXIT triggered. Session terminated.');
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
