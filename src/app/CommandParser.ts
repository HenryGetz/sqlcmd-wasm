import type { ParsedLineAction, VariableExpansionResult } from './types';

/**
 * Middleware-like parser for sqlcmd client directives and variable behavior.
 *
 * The parser only decides "what the line means" and keeps client-side script
 * variables. It intentionally does not execute SQL or talk to the UI directly.
 */
export class CommandParser {
  private readonly variables = new Map<string, string>();

  /**
   * Parse one line and classify it as a directive or plain SQL text.
   */
  public parseLine(rawLine: string): ParsedLineAction {
    const trimmed = rawLine.trim();

    if (/^reset$/i.test(trimmed)) {
      return { kind: 'reset' };
    }

    if (/^(quit|exit)$/i.test(trimmed)) {
      return { kind: 'exit' };
    }

    if (/^:listvar$/i.test(trimmed)) {
      return { kind: 'listvar' };
    }

    const readFileMatch = trimmed.match(/^:r(?:\s+(.*))?$/i);
    if (readFileMatch) {
      const requestedPath = readFileMatch[1]?.trim() ?? null;
      return {
        kind: 'read-file',
        requestedPath: requestedPath && requestedPath.length > 0 ? requestedPath : null,
      };
    }

    const helpMatch = trimmed.match(/^:help(?:\s+(.*))?$/i);
    if (helpMatch) {
      const topic = helpMatch[1]?.trim() ?? null;
      return {
        kind: 'help',
        topic: topic && topic.length > 0 ? topic : null,
      };
    }

    const onErrorMatch = trimmed.match(/^:on\s+error\s+(exit|ignore)$/i);
    if (onErrorMatch) {
      return {
        kind: 'on-error',
        mode: onErrorMatch[1].toLowerCase() as 'exit' | 'ignore',
      };
    }

    if (/^!!\s*cls$/i.test(trimmed)) {
      return { kind: 'clear-screen' };
    }

    const setVarMatch = trimmed.match(/^:setvar\s+([A-Za-z_][A-Za-z0-9_]*)\s+"(.*)"$/i);
    if (setVarMatch) {
      const [, name, quotedValue] = setVarMatch;
      return {
        kind: 'setvar',
        name,
        value: this.unescapeQuotedValue(quotedValue),
      };
    }

    const goMatch = trimmed.match(/^go(?:\s+(\d+))?$/i);
    if (goMatch) {
      const countToken = goMatch[1];
      const count = countToken ? Number.parseInt(countToken, 10) : 1;

      if (!Number.isInteger(count) || count < 1) {
        return {
          kind: 'invalid',
          message: 'GO count must be a positive integer.',
        };
      }

      return { kind: 'go', count };
    }

    if (/^:setvar\b/i.test(trimmed)) {
      return {
        kind: 'invalid',
        message: 'Invalid :setvar syntax. Use: :setvar Name "value"',
      };
    }

    if (/^:on\s+error\b/i.test(trimmed)) {
      return {
        kind: 'invalid',
        message: 'Invalid :On Error syntax. Use: :On Error [exit | ignore]',
      };
    }

    return { kind: 'sql', text: rawLine };
  }

  /**
   * Store or overwrite a variable.
   */
  public setVariable(name: string, value: string): void {
    this.variables.set(name, value);
  }

  /**
   * Returns a stable array to make listing deterministic.
   */
  public listVariables(): Array<[string, string]> {
    return [...this.variables.entries()].sort(([nameA], [nameB]) =>
      nameA.localeCompare(nameB),
    );
  }

  /**
   * Expand $(Name) placeholders inside SQL text.
   */
  public expandVariables(sql: string): VariableExpansionResult {
    const missing = new Set<string>();

    const expandedSql = sql.replace(/\$\(([A-Za-z_][A-Za-z0-9_]*)\)/g, (token, variableName) => {
      const value = this.variables.get(variableName);
      if (value === undefined) {
        missing.add(variableName);
        return token;
      }

      return value;
    });

    return {
      expandedSql,
      missingVariables: [...missing].sort((a, b) => a.localeCompare(b)),
    };
  }

  /**
   * Convert escaped quotes and backslashes to their literal values.
   */
  private unescapeQuotedValue(quotedValue: string): string {
    return quotedValue.replace(/\\(["\\])/g, '$1');
  }
}
