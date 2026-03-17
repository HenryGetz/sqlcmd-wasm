import type { OnErrorMode } from './types';

export type StartupDatabaseType = 'binary' | 'sql';

export type StartupSqlInput =
  | {
      kind: 'inline';
      text: string;
      source: 'sql' | 'sql64';
    }
  | {
      kind: 'url';
      source: string;
      parameter: 'sqlUrl' | 'sqlFile';
    };

export interface StartupVariableAssignment {
  name: string;
  value: string;
  source: 'setvar' | 'var';
}

export interface UrlStartupOptions {
  databaseSource: string | null;
  databaseType: StartupDatabaseType | null;
  initScriptSource: string | null;
  sqlInputs: StartupSqlInput[];
  startupVariables: StartupVariableAssignment[];
  startupOnErrorMode: OnErrorMode | null;
  autoRun: boolean;
  autoRunCount: number;
  notices: string[];
}

const TRUE_TOKENS = new Set(['1', 'true', 'yes', 'on']);
const FALSE_TOKENS = new Set(['0', 'false', 'no', 'off']);

/**
 * Parse browser query-string options that customize startup behavior.
 */
export function parseUrlStartupOptions(search: string): UrlStartupOptions {
  const params = new URLSearchParams(search);
  const notices: string[] = [];

  const sqlInputs: StartupSqlInput[] = [];
  const startupVariables: StartupVariableAssignment[] = [];

  for (const [key, value] of params.entries()) {
    if (key === 'sql') {
      const snippet = normalizeNewlines(value);

      if (snippet.length > 0) {
        sqlInputs.push({
          kind: 'inline',
          text: snippet,
          source: 'sql',
        });
      }

      continue;
    }

    if (key === 'sql64') {
      const decodedSnippet = decodeBase64SqlSnippet(value, notices);

      if (decodedSnippet !== null) {
        sqlInputs.push({
          kind: 'inline',
          text: decodedSnippet,
          source: 'sql64',
        });
      }

      continue;
    }

    if (key === 'sqlUrl' || key === 'sqlFile') {
      const source = value.trim();

      if (source.length > 0) {
        sqlInputs.push({
          kind: 'url',
          source,
          parameter: key,
        });
      } else {
        notices.push(`Ignored empty ${key} parameter. Provide a URL or relative path.`);
      }

      continue;
    }

    if (key === 'setvar') {
      const assignment = parseSetvarQueryValue(value, notices);

      if (assignment) {
        startupVariables.push(assignment);
      }

      continue;
    }

    if (key.startsWith('var.')) {
      const name = key.slice('var.'.length);

      if (!isValidVariableName(name)) {
        notices.push(`Ignored invalid variable name '${name}' from '${key}'.`);
        continue;
      }

      startupVariables.push({
        name,
        value: normalizeNewlines(value),
        source: 'var',
      });
    }
  }

  const runToken = getOptionalQueryValue(params, 'run') ?? getOptionalQueryValue(params, 'autorun');
  const parsedRun = runToken ? parseBooleanToken(runToken) : null;

  if (runToken && parsedRun === null) {
    notices.push(`Ignored invalid run flag '${runToken}'. Use true/false, yes/no, or 1/0.`);
  }

  const goToken = getOptionalQueryValue(params, 'go');
  let parsedGoCount: number | null = null;
  let autoRunCount = 1;

  if (goToken) {
    parsedGoCount = parsePositiveIntegerToken(goToken);

    if (parsedGoCount === null) {
      notices.push(`Ignored invalid go count '${goToken}'. GO count must be a positive integer.`);
    } else {
      autoRunCount = parsedGoCount;
    }
  }

  const autoRun = parsedRun ?? (parsedGoCount !== null);

  const databaseSource = getOptionalQueryValue(params, 'db');
  const databaseType = parseStartupDatabaseType(getOptionalQueryValue(params, 'dbType'), notices);

  if (!databaseSource && databaseType) {
    notices.push('Ignoring dbType because no db parameter was provided.');
  }

  const initScriptSource =
    getOptionalQueryValue(params, 'init') ?? getOptionalQueryValue(params, 'initSql');

  const onErrorToken =
    getOptionalQueryValue(params, 'onError') ?? getOptionalQueryValue(params, 'on_error');
  const startupOnErrorMode = parseOnErrorModeToken(onErrorToken, notices);

  return {
    databaseSource,
    databaseType,
    initScriptSource,
    sqlInputs,
    startupVariables,
    startupOnErrorMode,
    autoRun,
    autoRunCount,
    notices,
  };
}

function getOptionalQueryValue(params: URLSearchParams, key: string): string | null {
  const value = params.get(key);

  if (value === null) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseBooleanToken(token: string): boolean | null {
  const normalized = token.trim().toLowerCase();

  if (TRUE_TOKENS.has(normalized)) {
    return true;
  }

  if (FALSE_TOKENS.has(normalized)) {
    return false;
  }

  return null;
}

function parsePositiveIntegerToken(token: string): number | null {
  if (!/^\d+$/.test(token)) {
    return null;
  }

  const parsed = Number.parseInt(token, 10);

  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return null;
  }

  return parsed;
}

function parseStartupDatabaseType(token: string | null, notices: string[]): StartupDatabaseType | null {
  if (!token) {
    return null;
  }

  const normalized = token.toLowerCase();

  if (normalized === 'binary' || normalized === 'sqlite' || normalized === 'db') {
    return 'binary';
  }

  if (normalized === 'sql' || normalized === 'script') {
    return 'sql';
  }

  notices.push(`Ignored unsupported dbType '${token}'. Supported values are 'binary' or 'sql'.`);
  return null;
}

function parseOnErrorModeToken(token: string | null, notices: string[]): OnErrorMode | null {
  if (!token) {
    return null;
  }

  const normalized = token.toLowerCase();

  if (normalized === 'exit' || normalized === 'ignore') {
    return normalized;
  }

  notices.push(`Ignored invalid onError value '${token}'. Supported values are 'exit' or 'ignore'.`);
  return null;
}

function parseSetvarQueryValue(
  token: string,
  notices: string[],
): StartupVariableAssignment | null {
  const firstEqualsIndex = token.indexOf('=');
  const firstColonIndex = token.indexOf(':');

  let separatorIndex = -1;

  if (firstEqualsIndex >= 0 && firstColonIndex >= 0) {
    separatorIndex = Math.min(firstEqualsIndex, firstColonIndex);
  } else {
    separatorIndex = Math.max(firstEqualsIndex, firstColonIndex);
  }

  if (separatorIndex <= 0) {
    notices.push(`Ignored invalid setvar assignment '${token}'. Use setvar=Name=value.`);
    return null;
  }

  const name = token.slice(0, separatorIndex).trim();
  const value = normalizeNewlines(token.slice(separatorIndex + 1));

  if (!isValidVariableName(name)) {
    notices.push(`Ignored invalid variable name '${name}' in setvar assignment.`);
    return null;
  }

  return {
    name,
    value,
    source: 'setvar',
  };
}

function isValidVariableName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

function decodeBase64SqlSnippet(encodedSql: string, notices: string[]): string | null {
  const normalized = encodedSql.trim();

  if (normalized.length === 0) {
    return null;
  }

  try {
    const base64 = normalized.replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));

    return normalizeNewlines(new TextDecoder().decode(bytes));
  } catch {
    notices.push('Ignored invalid sql64 payload. Use URL-safe base64 encoded UTF-8 SQL text.');
    return null;
  }
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}
