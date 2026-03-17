#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import readline from 'node:readline/promises';
import { stderr, stdin, stdout } from 'node:process';

import { SqlCmdBrowserClient } from './lib/sqlcmdBrowserClient.mjs';

function printUsage() {
  stdout.write(`sqlcmd-wasm headless CLI

Usage:
  npm run cli:headless -- [options]

Options:
  --url <http-url>     App URL (default: http://127.0.0.1:5176/)
  --script <path>      Execute the contents of a file and exit
  --eval <sql>         Execute raw text input and exit
  --headed             Run a visible browser window
  --timeout <ms>       Command timeout (default: 10000)
  --help               Show this message

Interactive local commands:
  /help                Show local CLI commands
  /show                Print full transcript snapshot
  /wipe                Run WIPE in sqlcmd session
  /exit                Exit CLI
`);
}

function parseArgs(argv) {
  const options = {
    url: 'http://127.0.0.1:5176/',
    headless: true,
    timeoutMs: 10_000,
    scriptPath: null,
    evalText: null,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === '--help' || token === '-h') {
      options.help = true;
      continue;
    }

    if (token === '--url') {
      options.url = argv[index + 1] ?? options.url;
      index += 1;
      continue;
    }

    if (token === '--script') {
      options.scriptPath = argv[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (token === '--eval') {
      options.evalText = argv[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (token === '--headed') {
      options.headless = false;
      continue;
    }

    if (token === '--timeout') {
      const rawTimeout = argv[index + 1] ?? `${options.timeoutMs}`;
      const parsedTimeout = Number(rawTimeout);
      if (Number.isFinite(parsedTimeout) && parsedTimeout > 0) {
        options.timeoutMs = parsedTimeout;
      }
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  return options;
}

function normalizeDelta(delta) {
  const normalized = delta.replace(/^\n+/, '');

  return normalized.length > 0 ? normalized : '(no output)\n';
}

async function runScriptInput(client, rawInput, timeoutMs) {
  const normalizedInput = rawInput.endsWith('\n') ? rawInput : `${rawInput}\n`;
  const { delta } = await client.sendScriptAndRead(normalizedInput, timeoutMs);
  stdout.write(normalizeDelta(delta));
}

async function runInteractive(client, timeoutMs) {
  const interfaceHandle = readline.createInterface({
    input: stdin,
    output: stdout,
  });

  stdout.write('Connected to sqlcmd-wasm automation bridge. Type /help for local commands.\n');

  const initialSnapshot = await client.getTranscriptDelta();

  if (initialSnapshot.full.length > 0) {
    stdout.write(`${initialSnapshot.full}\n`);
  }

  while (true) {
    const nextLine = await interfaceHandle.question('cli> ');
    const trimmed = nextLine.trim();

    if (trimmed === '/exit') {
      break;
    }

    if (trimmed === '/help') {
      stdout.write('/help /show /wipe /exit\n');
      continue;
    }

    if (trimmed === '/show') {
      const transcript = await client.getTranscript();
      stdout.write(`${transcript}\n`);
      continue;
    }

    if (trimmed === '/wipe') {
      const { delta } = await client.sendLineAndRead('WIPE', timeoutMs);
      stdout.write(normalizeDelta(delta));
      continue;
    }

    const { delta } = await client.sendLineAndRead(nextLine, timeoutMs);
    stdout.write(normalizeDelta(delta));
  }

  interfaceHandle.close();
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printUsage();
    return;
  }

  let client;

  try {
    client = await SqlCmdBrowserClient.connect({
      url: options.url,
      headless: options.headless,
      timeoutMs: options.timeoutMs,
    });

    if (options.scriptPath) {
      const scriptText = await readFile(options.scriptPath, 'utf8');
      await runScriptInput(client, scriptText, options.timeoutMs);
      return;
    }

    if (options.evalText) {
      await runScriptInput(client, options.evalText, options.timeoutMs);
      return;
    }

    await runInteractive(client, options.timeoutMs);
  } finally {
    if (client) {
      await client.close();
    }
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  stderr.write(`headless-cli error: ${message}\n`);
  process.exitCode = 1;
});
