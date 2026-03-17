import 'xterm/css/xterm.css';

import './styles.css';
import { CommandParser } from './app/CommandParser';
import { ExecutionEngine } from './app/ExecutionEngine';
import { PersistenceStore } from './app/PersistenceStore';
import { SqlCmdSession } from './app/SqlCmdSession';
import { TerminalUI } from './app/TerminalUI';
import { parseUrlStartupOptions } from './app/UrlStartupOptions';

/**
 * Application bootstrap.
 *
 * The entrypoint wires independently testable modules together. This keeps the
 * architecture portable for future embedding inside BuddySQL.
 */
async function bootstrap(): Promise<void> {
  const app = document.querySelector<HTMLDivElement>('#app');

  if (!app) {
    throw new Error('Unable to find #app mount element.');
  }

  app.innerHTML = `
    <div class="terminal-shell">
      <div id="terminal" class="terminal-mount"></div>
    </div>
  `;

  const terminalElement = document.querySelector<HTMLDivElement>('#terminal');

  if (!terminalElement) {
    throw new Error('Unable to find terminal mount element.');
  }

  const terminalUi = new TerminalUI(terminalElement);
  terminalUi.initialize();

  const commandParser = new CommandParser();
  const executionEngine = await ExecutionEngine.initialize();
  const persistenceStore = new PersistenceStore();
  const startupOptions = parseUrlStartupOptions(window.location.search);

  const session = new SqlCmdSession(
    terminalUi,
    commandParser,
    executionEngine,
    startupOptions,
    persistenceStore,
  );

  if (import.meta.env.DEV) {
    (window as Window & { __sqlcmdSession?: SqlCmdSession }).__sqlcmdSession =
      session;
  }

  await session.start();
}

bootstrap().catch((error: unknown) => {
  const app = document.querySelector<HTMLDivElement>('#app');
  const message = error instanceof Error ? error.message : String(error);

  if (app) {
    app.innerHTML = `<pre style="color:#ff6b6b;padding:1rem;">Fatal startup error: ${message}</pre>`;
  }

  // Keep this log for browser-level debugging in case startup fails early.
  console.error('Fatal startup error:', error);
});
