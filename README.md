# sqlcmd-wasm

Because sometimes you want to test T-SQL in a browser tab instead of installing half of Microsoft's ecosystem just to check whether `GO` is in the right spot.

`sqlcmd-wasm` is a browser-first emulator of the `sqlcmd` REPL. It gives you the familiar multi-line prompt workflow (`1>`, `2>`, `GO`) while running entirely in the browser with WebAssembly.

It is intentionally opinionated:
- It accepts SQL Server-flavored input (T-SQL).
- It transpiles T-SQL to SQLite-compatible SQL using `@polyglot-sql/sdk`.
- It executes the translated SQL in `sql.js` (SQLite in WASM).
- It renders results and errors in a terminal-like UI using `xterm.js`.

So yes, it is a SQL Server-ish REPL with zero SQL Server process running.

## Why This Exists

If you build SQL tooling, teach SQL, prototype query flows, or just want fast feedback loops, this gives you:
- A fully browser-based environment for testing T-SQL syntax and interactive batch behavior.
- No local database server required.
- Portable architecture you can embed into larger tools (like BuddySQL).

It is very good for:
- REPL behavior testing (`GO`, buffers, variable substitution, directives).
- Rapid syntax experimentation.
- Demo and educational environments.

It is not trying to be:
- A full SQL Server engine.
- A perfect semantic/runtime clone of every SQL Server feature.

## Stack

- `Vite` + `TypeScript`
- `xterm.js` for terminal UI
- `@polyglot-sql/sdk` for T-SQL -> SQLite transpilation
- `sql.js` for SQLite WASM execution

## Quick Start

```bash
npm install
npm run dev -- --host 0.0.0.0 --port 5176
```

Open the printed local/network URL in your browser.

Build for production:

```bash
npm run build
npm run preview
```

## Example Session

```text
1> :setvar TableName "TestUsers"
1> CREATE TABLE $(TableName) (Id INT, Name VARCHAR(50));
2> INSERT INTO $(TableName) VALUES (1, 'Alice');
3> GO
(1 rows affected)
1> SELECT * FROM $(TableName);
2> GO
+----+-------+
| Id | Name  |
+----+-------+
| 1  | Alice |
+----+-------+
(1 rows affected)
1>
```

## Supported REPL Commands

- `GO [count]`: Execute current batch (optionally N times).
- `RESET`: Clear statement cache.
- `QUIT` / `EXIT`: Terminate session input.
- `:setvar <name> "value"`: Set scripting variable.
- `:listvar`: List all variables.
- `$(VariableName)`: Expand variable in SQL before transpilation.
- `:r [filename]`: Browser-native file import into current batch.
- `:On Error [exit|ignore]`: Configure session behavior on errors.
- `:Help`: Show in-terminal help.
- `!! cls`: Clear terminal viewport like `cls`.

## Error Formatting

Errors are normalized to SQL Server-style output:

```text
Msg {ErrorCode}, Level {Level}, State {State}, Server WasmSQL, Line {LineNumber}
{ErrorMessage}
```

Includes mapping for common SQLite runtime messages:
- Missing table -> `Msg 208` (`Invalid object name ...`)
- Missing column -> `Msg 207` (`Invalid column name ...`)
- Constraint failure -> `Msg 2627`
- Fallback -> `Msg 50000`

Transpile/syntax failures are mapped to `Msg 102` syntax errors.

## Architecture

Core modules in `src/app`:
- `TerminalUI.ts`: xterm setup, input capture, prompt rendering.
- `CommandParser.ts`: Directive interception and classification.
- `SqlCmdSession.ts`: Session orchestration and directive handling.
- `ExecutionEngine.ts`: Transpile + SQLite execution pipeline.
- `ErrorFormatter.ts`: SQL Server-style error middleware.
- `formatters/tableFormatter.ts`: ASCII table rendering.

This split is deliberate so the REPL core can be reused in other apps.

## Limitations (a.k.a. Honest Fine Print)

- Runtime semantics are SQLite-backed, not true SQL Server engine semantics.
- Some T-SQL features may transpile imperfectly or be unsupported.
- `:r` uses browser file picker APIs, so it behaves like web UX, not local shell access.

Still, for fast interactive T-SQL testing in-browser, it is extremely useful.

## License

MIT (project dependencies keep their own licenses).

