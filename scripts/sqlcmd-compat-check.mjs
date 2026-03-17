#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';

import { SqlCmdBrowserClient } from './lib/sqlcmdBrowserClient.mjs';

function parseArgs(argv) {
  const options = {
    url: 'http://127.0.0.1:5176/',
    timeoutMs: 20_000,
    outputDir: '.tmp/compat-check',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === '--url') {
      options.url = argv[index + 1] ?? options.url;
      index += 1;
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

    if (token === '--output-dir') {
      options.outputDir = argv[index + 1] ?? options.outputDir;
      index += 1;
      continue;
    }

    if (token === '--help' || token === '-h') {
      process.stdout.write(`Compatibility checker

Usage:
  npm run compat:check -- [options]

Options:
  --url <http-url>        sqlcmd-wasm URL (default: http://127.0.0.1:5176/)
  --timeout <ms>          Timeout for browser commands (default: 20000)
  --output-dir <path>     Directory for raw logs (default: .tmp/compat-check)
`);
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  return options;
}

function getSqlServerPassword() {
  return execFileSync('docker', ['exec', 'mssql', 'printenv', 'MSSQL_SA_PASSWORD'], {
    encoding: 'utf8',
  }).trim();
}

async function runSqlServerScript(scriptText, password) {
  return new Promise((resolve, reject) => {
    const command = spawn(
      'docker',
      [
        'exec',
        '-i',
        'mssql',
        '/opt/mssql-tools18/bin/sqlcmd',
        '-S',
        'tcp:127.0.0.1,1433',
        '-U',
        'sa',
        '-P',
        password,
        '-C',
      ],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    let stdoutText = '';
    let stderrText = '';

    command.stdout.on('data', (chunk) => {
      stdoutText += String(chunk);
    });

    command.stderr.on('data', (chunk) => {
      stderrText += String(chunk);
    });

    command.on('error', (error) => {
      reject(error);
    });

    command.on('close', (exitCode) => {
      resolve({
        exitCode: exitCode ?? 1,
        stdoutText,
        stderrText,
      });
    });

    command.stdin.write(scriptText);
    command.stdin.end();
  });
}

function parseSummary(outputText) {
  const rowCounts = [...outputText.matchAll(/\((\d+)\s+rows?\s+affected\)/gi)]
    .map((match) => {
      return Number(match[1]);
    })
    // SQL Server and SQLite differ on when they emit explicit "0 rows affected"
    // for DDL; ignore zeros so rowcount checks stay signal-heavy.
    .filter((count) => count > 0);

  const errorCodes = [...outputText.matchAll(/Msg\s+(\d+)/gi)].map((match) => {
    return Number(match[1]);
  });

  const tokens = [
    ...new Set(
      [...outputText.matchAll(/CASE_[A-Z0-9_]+=[A-Za-z0-9:_-]+/g)].map((match) => {
        return match[0];
      }),
    ),
  ];

  return {
    rowCounts,
    errorCodes,
    tokens,
  };
}

function createCases(runId) {
  const tableOne = `compat_identity_${runId}`;
  const tableTwo = `compat_vars_${runId}`;
  const databaseName = `compat_db_${runId}`;

  return [
    {
      name: 'smoke-select',
      script: `SELECT 'CASE_SMOKE=1' AS compat_token;\nGO\n`,
    },
    {
      name: 'identity-insert',
      script: `CREATE TABLE ${tableOne} (id INT PRIMARY KEY IDENTITY(1,1), name VARCHAR(30));\nGO\nINSERT INTO ${tableOne} (name) VALUES ('Ada'), ('Lin');\nGO\nSELECT 'CASE_IDENTITY_MAX=' + CAST(MAX(id) AS VARCHAR(20)) AS compat_token FROM ${tableOne};\nGO\n`,
    },
    {
      name: 'functions-len-isnull',
      script: `SELECT 'CASE_FUNCS=' + CAST(LEN('abc') AS VARCHAR(20)) + ':' + ISNULL(NULL, 'fallback') AS compat_token;\nGO\n`,
    },
    {
      name: 'date-functions',
      script: `SELECT 'CASE_DATE=' + CAST(YEAR(GETDATE()) AS VARCHAR(20)) AS compat_token;\nGO\n`,
    },
    {
      name: 'setvar-expansion',
      script: `:setvar TableName ${tableTwo}\nCREATE TABLE $(TableName) (id INT);\nGO\nINSERT INTO $(TableName) VALUES (1), (2), (3);\nGO\nSELECT 'CASE_VAR_TOTAL=' + CAST(COUNT(*) AS VARCHAR(20)) AS compat_token FROM $(TableName);\nGO\n`,
    },
    {
      name: 'create-and-use-database',
      script: `CREATE DATABASE ${databaseName};\nGO\nUSE ${databaseName};\nGO\nCREATE TABLE compat_table (id INT);\nGO\nINSERT INTO compat_table VALUES (1), (2);\nGO\nSELECT 'CASE_DB_ROWS=' + CAST(COUNT(*) AS VARCHAR(20)) AS compat_token FROM compat_table;\nGO\n`,
    },
    {
      name: 'missing-table-error',
      script: `SELECT * FROM compat_missing_${runId};\nGO\n`,
    },
  ];
}

async function runBrowserCase(client, scriptText, timeoutMs) {
  await client.clearPersistedAndRuntimeState();
  await client.getTranscriptDelta();

  const { delta } = await client.sendScriptAndRead(scriptText, timeoutMs);

  return delta;
}

function compareSummaries(browserSummary, sqlServerSummary) {
  return {
    rowCountsMatch:
      JSON.stringify(browserSummary.rowCounts) ===
      JSON.stringify(sqlServerSummary.rowCounts),
    errorCodesMatch:
      JSON.stringify(browserSummary.errorCodes) ===
      JSON.stringify(sqlServerSummary.errorCodes),
    tokensMatch:
      JSON.stringify(browserSummary.tokens) === JSON.stringify(sqlServerSummary.tokens),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await mkdir(options.outputDir, { recursive: true });

  const runId = Date.now().toString(36);
  const password = getSqlServerPassword();
  const cases = createCases(runId);

  const client = await SqlCmdBrowserClient.connect({
    url: options.url,
    headless: true,
    timeoutMs: options.timeoutMs,
  });

  const summaryRows = [];

  try {
    for (const compatCase of cases) {
      const browserOutput = await runBrowserCase(
        client,
        compatCase.script,
        options.timeoutMs,
      );
      const sqlServerResult = await runSqlServerScript(compatCase.script, password);
      const sqlServerOutput = `${sqlServerResult.stdoutText}${sqlServerResult.stderrText}`;

      const browserSummary = parseSummary(browserOutput);
      const sqlServerSummary = parseSummary(sqlServerOutput);
      const comparison = compareSummaries(browserSummary, sqlServerSummary);

      const browserLogPath = path.join(
        options.outputDir,
        `${compatCase.name}.browser.log`,
      );
      const sqlServerLogPath = path.join(
        options.outputDir,
        `${compatCase.name}.sqlserver.log`,
      );

      await writeFile(browserLogPath, browserOutput, 'utf8');
      await writeFile(sqlServerLogPath, sqlServerOutput, 'utf8');

      summaryRows.push({
        caseName: compatCase.name,
        browserSummary,
        sqlServerSummary,
        comparison,
        browserLogPath,
        sqlServerLogPath,
      });
    }
  } finally {
    await client.close();
  }

  let hasMismatch = false;

  process.stdout.write('Compatibility report\n');
  process.stdout.write('--------------------\n');

  for (const row of summaryRows) {
    const checks = [
      row.comparison.rowCountsMatch,
      row.comparison.errorCodesMatch,
      row.comparison.tokensMatch,
    ];

    const casePassed = checks.every(Boolean);
    const status = casePassed ? 'PASS' : 'FAIL';
    if (!casePassed) {
      hasMismatch = true;
    }

    process.stdout.write(`\n[${status}] ${row.caseName}\n`);
    process.stdout.write(
      `  browser  rowCounts=${JSON.stringify(row.browserSummary.rowCounts)} errors=${JSON.stringify(row.browserSummary.errorCodes)} tokens=${JSON.stringify(row.browserSummary.tokens)}\n`,
    );
    process.stdout.write(
      `  sqlsrv   rowCounts=${JSON.stringify(row.sqlServerSummary.rowCounts)} errors=${JSON.stringify(row.sqlServerSummary.errorCodes)} tokens=${JSON.stringify(row.sqlServerSummary.tokens)}\n`,
    );
    process.stdout.write(
      `  logs: ${row.browserLogPath} | ${row.sqlServerLogPath}\n`,
    );
  }

  if (hasMismatch) {
    process.stdout.write('\nResult: mismatches found. Inspect logs for details.\n');
    process.exitCode = 1;
    return;
  }

  process.stdout.write('\nResult: all compatibility checks matched for this suite.\n');
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`compat-check error: ${message}\n`);
  process.exitCode = 1;
});
