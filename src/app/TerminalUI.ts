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

  private previousInputEndedWithCarriageReturn = false;
  private isConsumingAnsiEscapeSequence = false;

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
    this.terminal.write(`${promptNumber}> `);
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

    for (const char of chunk) {
      if (this.isConsumingAnsiEscapeSequence) {
        if (this.isAnsiEscapeTerminator(char)) {
          this.isConsumingAnsiEscapeSequence = false;
        }

        continue;
      }

      if (char === '\n' && this.previousInputEndedWithCarriageReturn) {
        this.previousInputEndedWithCarriageReturn = false;
        continue;
      }

      this.previousInputEndedWithCarriageReturn = false;

      if (char === '\r' || char === '\n') {
        if (char === '\r') {
          this.previousInputEndedWithCarriageReturn = true;
        }

        this.submitCurrentLine();
        continue;
      }

      if (char === '\u007f') {
        this.handleBackspace();
        continue;
      }

      if (char === '\u0003') {
        // Ctrl+C clears the current line but keeps the session alive.
        this.terminal.write('^C\r\n');
        this.currentInput = '';
        continue;
      }

      if (char === '\u001b') {
        // Consume ANSI escape/control sequences (arrow keys, etc.).
        this.isConsumingAnsiEscapeSequence = true;
        continue;
      }

      if (this.isPrintable(char)) {
        this.currentInput += char;
        this.terminal.write(char);
      }
    }
  }

  private submitCurrentLine(): void {
    this.terminal.write('\r\n');
    const submittedLine = this.currentInput;
    this.currentInput = '';

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
