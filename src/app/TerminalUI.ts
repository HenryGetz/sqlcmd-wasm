import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from 'xterm';

/**
 * Encapsulates xterm setup, user input capture, prompt rendering, and colored
 * output helpers.
 */
export class TerminalUI {
  private readonly terminal: Terminal;
  private readonly fitAddon: FitAddon;

  private currentInput = '';
  private lineHandler: ((line: string) => void | Promise<void>) | null = null;
  private currentPromptText = '';

  private readonly commandHistory: string[] = [];
  private historyCursor: number | null = null;
  private historyDraft = '';

  private previousInputEndedWithCarriageReturn = false;
  private pendingEscapeSequence = '';

  private isPermanentlyLocked = false;
  private isTemporarilyDisabled = false;

  public constructor(private readonly mountElement: HTMLElement) {
    this.terminal = new Terminal({
      convertEol: true,
      cursorBlink: true,
      cursorStyle: 'underline',
      fontFamily: "'CascadiaMonoLocal', 'Cascadia Mono', 'Consolas', 'Lucida Console', monospace",
      fontSize: 16,
      fontWeight: 'normal',
      lineHeight: 1.2,
      scrollback: 1500,
      theme: {
        background: '#0C0C0C',
        foreground: '#CCCCCC',
        cursor: '#CCCCCC',
        cursorAccent: '#0C0C0C',
        selectionBackground: '#FFFFFF',
        selectionForeground: '#000000',
      },
    });

    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);
  }

  /**
   * Boot xterm and bind user keyboard input listeners.
   */
  public initialize(): void {
    this.terminal.open(this.mountElement);

    // Wait one frame so the mount element has stable dimensions before fitting.
    requestAnimationFrame(() => {
      this.fitAddon.fit();
      this.terminal.focus();
    });

    // Re-fit when custom fonts are loaded so glyph metrics align correctly.
    if ('fonts' in document) {
      void document.fonts.ready.then(() => {
        this.fitAddon.fit();
      });
    }

    window.addEventListener('resize', () => {
      this.fitAddon.fit();
    });

    this.mountElement.addEventListener('click', () => {
      this.terminal.focus();
    });

    this.terminal.onData((chunk) => {
      this.handleInputChunk(chunk);
    });
  }

  /**
   * Register line submission callback (triggered on Enter).
   */
  public onLine(handler: (line: string) => void | Promise<void>): void {
    this.lineHandler = handler;
  }

  /**
   * Render a sqlcmd-style numbered prompt.
   */
  public renderPrompt(promptNumber: number): void {
    // Use write() (not writeln()) so the cursor stays on the prompt line.
    this.currentPromptText = `${promptNumber}> `;
    this.terminal.write(this.currentPromptText);
  }

  /**
   * Write a standard line and end with CRLF.
   */
  public writeLine(message = ''): void {
    this.terminal.writeln(message);
  }

  /**
   * Write an informational line.
   */
  public writeInfo(message: string): void {
    this.terminal.writeln(message);
  }

  /**
   * Write an error line in red.
   */
  public writeError(message: string): void {
    this.terminal.writeln(`\x1b[31m${message}\x1b[0m`);
  }

  /**
   * Clear terminal viewport + scrollback to mimic `cls` behavior.
   */
  public clearScreen(): void {
    this.terminal.clear();
  }

  /**
   * Inject raw terminal input bytes (used by headless automation).
   */
  public injectInput(chunk: string): void {
    this.handleInputChunk(chunk);
  }

  /**
   * Send a full line exactly like typing text and pressing Enter.
   */
  public injectLine(line: string): void {
    this.handleInputChunk(line);
    this.handleInputChunk('\r');
  }

  /**
   * Snapshot all visible + scrollback terminal text.
   */
  public getTranscript(): string {
    const activeBuffer = this.terminal.buffer.active;
    const lines: string[] = [];

    for (let index = 0; index < activeBuffer.length; index += 1) {
      const bufferLine = activeBuffer.getLine(index);

      if (!bufferLine) {
        continue;
      }

      lines.push(bufferLine.translateToString(true));
    }

    while (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }

    return lines.join('\n');
  }

  /**
   * Temporarily pause input while asynchronous execution is running.
   */
  public setInputEnabled(enabled: boolean): void {
    this.isTemporarilyDisabled = !enabled;
  }

  /**
   * Permanently disable input for session termination.
   */
  public lockInput(): void {
    this.isPermanentlyLocked = true;
  }

  private handleInputChunk(chunk: string): void {
    if (this.isPermanentlyLocked || this.isTemporarilyDisabled) {
      return;
    }

    const data = this.pendingEscapeSequence + chunk;
    let index = 0;

    while (index < data.length) {
      const char = data[index];

      if (char === '\u001b') {
        const sequenceResult = this.consumeEscapeSequence(data, index);

        if (sequenceResult.kind === 'incomplete') {
          this.pendingEscapeSequence = data.slice(index);
          return;
        }

        index = sequenceResult.nextIndex;
        continue;
      }

      if (char === '\n' && this.previousInputEndedWithCarriageReturn) {
        this.previousInputEndedWithCarriageReturn = false;
        index += 1;
        continue;
      }

      this.previousInputEndedWithCarriageReturn = false;

      if (char === '\r' || char === '\n') {
        if (char === '\r') {
          this.previousInputEndedWithCarriageReturn = true;
        }

        this.submitCurrentLine();
        index += 1;
        continue;
      }

      if (char === '\u007f') {
        this.handleBackspace();
        index += 1;
        continue;
      }

      if (char === '\u0003') {
        // Ctrl+C clears the current line but keeps the session alive.
        this.terminal.write('^C\r\n');
        this.currentInput = '';
        this.historyCursor = null;
        this.historyDraft = '';
        index += 1;
        continue;
      }

      if (this.isPrintable(char)) {
        this.currentInput += char;
        this.terminal.write(char);
      }

      index += 1;
    }

    this.pendingEscapeSequence = '';
  }

  private submitCurrentLine(): void {
    this.terminal.write('\r\n');
    const submittedLine = this.currentInput;
    this.currentInput = '';
    this.historyCursor = null;
    this.historyDraft = '';

    if (submittedLine.trim().length > 0) {
      const previous = this.commandHistory[this.commandHistory.length - 1];

      if (previous !== submittedLine) {
        this.commandHistory.push(submittedLine);
      }
    }

    if (this.lineHandler) {
      void this.lineHandler(submittedLine);
    }
  }

  private handleBackspace(): void {
    if (this.currentInput.length === 0) {
      return;
    }

    this.currentInput = this.currentInput.slice(0, -1);
    this.terminal.write('\b \b');
  }

  private consumeEscapeSequence(
    data: string,
    startIndex: number,
  ): { kind: 'complete'; nextIndex: number } | { kind: 'incomplete' } {
    if (startIndex + 1 >= data.length) {
      return { kind: 'incomplete' };
    }

    const next = data[startIndex + 1];

    // Non-CSI escape sequences are ignored.
    if (next !== '[') {
      return {
        kind: 'complete',
        nextIndex: startIndex + 2,
      };
    }

    let cursor = startIndex + 2;

    while (cursor < data.length) {
      const token = data[cursor];

      if (!this.isAnsiEscapeTerminator(token)) {
        cursor += 1;
        continue;
      }

      if (token === 'A') {
        this.handleHistoryUp();
      } else if (token === 'B') {
        this.handleHistoryDown();
      }

      return {
        kind: 'complete',
        nextIndex: cursor + 1,
      };
    }

    return { kind: 'incomplete' };
  }

  private handleHistoryUp(): void {
    if (this.commandHistory.length === 0) {
      return;
    }

    if (this.historyCursor === null) {
      this.historyDraft = this.currentInput;
      this.historyCursor = this.commandHistory.length - 1;
    } else if (this.historyCursor > 0) {
      this.historyCursor -= 1;
    }

    this.currentInput = this.commandHistory[this.historyCursor];
    this.redrawCurrentInputLine();
  }

  private handleHistoryDown(): void {
    if (this.historyCursor === null) {
      return;
    }

    if (this.historyCursor < this.commandHistory.length - 1) {
      this.historyCursor += 1;
      this.currentInput = this.commandHistory[this.historyCursor];
    } else {
      this.historyCursor = null;
      this.currentInput = this.historyDraft;
      this.historyDraft = '';
    }

    this.redrawCurrentInputLine();
  }

  private redrawCurrentInputLine(): void {
    this.terminal.write('\x1b[2K\r');
    this.terminal.write(`${this.currentPromptText}${this.currentInput}`);
  }

  private isPrintable(char: string): boolean {
    return char >= ' ' && char !== '\u007f';
  }

  /**
   * ANSI escape sequences terminate with a final byte in the 0x40-0x7E range.
   */
  private isAnsiEscapeTerminator(char: string): boolean {
    return char >= '@' && char <= '~';
  }
}
