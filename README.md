# sqlcmd-wasm

Because sometimes you want to test SQL Server syntax in a browser tab instead of installing half of Microsoft's ecosystem just to check whether `GO` is in the right spot.

`sqlcmd-wasm` is a browser-first emulator of the `sqlcmd` REPL. It gives you the familiar multi-line prompt workflow (`1>`, `2>`, `GO`) while running entirely in the browser with WebAssembly.

It is intentionally opinionated:
- It accepts SQL Server-flavored input.
- It transpiles SQL Server SQL (aka T-SQL) to SQLite-compatible SQL using `@polyglot-sql/sdk`.
- It executes the translated SQL in `sql.js` (SQLite in WASM).
- It renders results and errors in a terminal-like UI using `xterm.js`.

So yes, it is a SQL Server-ish REPL with zero SQL Server process running.

## Why This Exists

If you build SQL tooling, teach SQL, prototype query flows, or just want fast feedback loops, this gives you:
- A fully browser-based environment for testing SQL Server syntax and interactive batch behavior.
- No local database server required.
- Portable architecture you can embed into larger tools.

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
- `@polyglot-sql/sdk` for SQL Server SQL -> SQLite transpilation
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

## Persistence

Session state is automatically journaled in browser `IndexedDB` and restored on reload.

- Executed SQL batches are replayed in order when the page opens.
- `CREATE DATABASE`, `USE`, and `DROP DATABASE` directives are also replayed.
- Read-only queries (like `SELECT`) are not journaled, so diagnostics don’t bloat restore history.
- Persistence is scoped per browser origin (for example, `localhost` and a TailNet IP keep separate journals).
- This keeps your in-browser schema/data alive across refreshes without a backend.

To fully clear state (current in-memory DB plus persisted journal), run:

```text
WIPE
```

`RESET ALL` is an alias for `WIPE`.

## URL-Driven Startup

You can deep-link into a prepared session by passing query parameters.

- `sql`: Preload SQL text into the statement buffer. You can repeat this parameter.
- `sql64`: Preload SQL via URL-safe base64 (useful for multi-line or quote-heavy SQL).
- `sqlUrl` / `sqlFile`: Fetch SQL text from a URL/path and preload it into the statement buffer.
- `run` / `autorun`: Auto-execute preloaded SQL (`true/false`, `yes/no`, `1/0`).
- `go`: Auto-run repeat count (`go=3` means execute preloaded batch 3 times).
- `setvar`: Set sqlcmd variables at startup (`setvar=Name=value` or `setvar=Name:value`).
- `var.<Name>`: Alternative variable syntax (`var.TableName=Users`).
- `onError` / `on_error`: Set startup `:On Error` mode (`exit` or `ignore`).
- `db`: Load a startup database file or SQL script URL before prompt is shown.
- `dbType`: Optional override for `db` type (`binary` or `sql`).
- `init` / `initSql`: Load and execute an additional SQLite SQL script after `db`.

`db`/`init` URLs can be relative paths. For static assets, put files in `public/`.

Example links:

```text
/?sql=SELECT%201%20AS%20hello;
/?sql=CREATE%20TABLE%20demo(id%20INT);&sql=INSERT%20INTO%20demo%20VALUES%20(1);&run=1
/?db=./db/startup.sqlite&sql=SELECT%20name%20FROM%20users%20ORDER%20BY%20id;&run=true
/?db=./bootstrap/sample.sql&dbType=sql&sql=SELECT%20label%20FROM%20startup_demo%20ORDER%20BY%20id;&go=2
/?db=./db/startup.sqlite&init=./bootstrap/sample.sql&sql=SELECT%20COUNT(*)%20FROM%20startup_demo;&autorun=yes
/?setvar=TableName=users&sql=SELECT%20*%20FROM%20$(TableName);&run=true
/?var.TableName=users&var.MinId=1&sql=SELECT%20*%20FROM%20$(TableName)%20WHERE%20id%20%3E=%20$(MinId);
/?sqlUrl=./bootstrap/sample.sql&sql=SELECT%20COUNT(*)%20AS%20total%20FROM%20startup_demo;&run=true
/?onError=exit&sql=SELECT%20*%20FROM%20does_not_exist;&run=true
```

A valid `go` value implies auto-run when `run`/`autorun` is not explicitly set. Invalid `go` values are ignored with a startup notice.
When `sql`, `sql64`, and `sqlUrl`/`sqlFile` are mixed, they are loaded in URL query order.

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
- `WIPE` / `RESET ALL`: Clear in-memory DB, active context, and IndexedDB journal.
- `QUIT` / `EXIT`: Terminate session input.
- `:setvar <name> "value"`: Set scripting variable.
- `:listvar`: List all variables.
- `$(VariableName)`: Expand variable in SQL before transpilation.
- `:r [filename]`: Browser-native file import into current batch.
- `:On Error [exit|ignore]`: Configure session behavior on errors.
- `:Intro`: Show a first-run tutorial in sqlcmd style.
- `:Help`: Show in-terminal help.
- `!! cls`: Clear terminal viewport like `cls`.

When executing imported SQL, sqlcmd-style `GO` separator lines are honored as true batch separators.

Database context directives are mapped to SQLite multi-database behavior:
- `CREATE DATABASE X` -> `ATTACH DATABASE ':memory:' AS X`
- `USE X` -> switches active schema context to `X`
- `DROP DATABASE X` -> `DETACH DATABASE X`

With an active `USE` context, unqualified `CREATE TABLE` statements are created in that attached schema, and `sqlite_master` / `sqlite_schema` queries are scoped to the active schema so table discovery behaves as expected.

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
- Some SQL Server-specific features may transpile imperfectly or be unsupported.
- `:r` uses browser file picker APIs, so it behaves like web UX, not local shell access.

Still, for fast interactive SQL Server syntax testing in-browser, it is extremely useful.

## License

MIT (project dependencies keep their own licenses).
