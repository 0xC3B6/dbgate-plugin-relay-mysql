# DbGate Relay MySQL Plugin

English | [简体中文](README.zh-CN.md)

`dbgate-plugin-relay-mysql` is a read-only external driver for DbGate Web 7.2.1. It keeps the existing access path—local `relay-cli`, an interactive relay shell, SSH, and the remote `mysql` CLI—while reusing DbGate's database tree, SQL editor, and data grid.

The plugin never opens a direct MySQL TCP connection. With the bundled runner, a private local broker keeps one Relay/SSH session per complete profile and starts only the remote `mysql --xml` command for each query. The session is recycled after one hour without a query. This makes wide results render as a normal horizontally scrollable, resizable grid without requiring Touch ID for every query.

## MVP features

- Visible non-system databases, tables, views, and columns in DbGate's left tree.
- Read-only `SELECT`, `SHOW`, `DESC`/`DESCRIBE`, and `EXPLAIN SELECT` queries.
- DbGate table tabs with 100-row incremental loading by default.
- Streaming XML parsing with `NULL`, Unicode, XML entities, newlines, tabs, and duplicate column names preserved.
- A 5,000-row cap for manual results and a fixed 32 MiB XML-result limit.
- Relay, SSH, and MySQL routing settings managed in each DbGate connection.
- Local-only DbGate launcher bound to `127.0.0.1`.

This MVP is tested against DbGate Web Community 7.2.1. Other DbGate versions are not yet a compatibility promise.

## Requirements

- macOS or another Unix-like local system with Node.js 20.9 or newer.
- `/usr/bin/expect`, `relay-cli`, and `ssh` available locally.
- `bash`, `base64`, and a MySQL CLI that supports `--xml`, `--quick`, and `--binary-mode` on the SSH target.
- A MySQL account with genuine read-only privileges.

The SQL gate is an accident-prevention layer, not the authorization boundary. For a hard guarantee, use an account without write, DDL, `FILE`, `EXECUTE`, temporary-table, or administrative privileges.

## Install for local development

```bash
npm ci --cache .npm-cache
npm run plugin:install-local -- --clean
npm run start:local
```

Then open <http://127.0.0.1:3100>. The install command builds and copies the external plugin into `.local/dbgate/plugins`; it does not patch or rebuild DbGate.

`--clean` replaces only the installed plugin directory and preserves DbGate's saved connections and workspace. The E2E suite uses a separate `.local/dbgate-e2e` workspace and never cleans the normal local workspace.

The repository launcher sets DbGate console and file logging to `warn` by default because DbGate itself includes SQL text in lower-level logs. Overriding `CONSOLE_LOG_LEVEL`, `FILE_LOG_LEVEL`, or `LOG_LEVEL` with `info`/`debug` can persist SQL outside this plugin. DbGate may also retain SQL editor/tab state as part of its normal workspace behavior, so SQL text should never contain credentials.

## Add a connection from a local profile

Start DbGate without `CONNECTIONS`, `SINGLE_CONNECTION`, or other connection-injection variables, then use **+ → Connection → Relay MySQL**. DbGate 7.2.1 does not expose a plugin API for adding a separate profile-management page, so the native connection list is the profile manager: one Relay MySQL connection represents one complete Relay/SSH/MySQL route.

For the shortest setup, leave **Use custom advanced Relay, SSH and MySQL settings** disabled and choose **WAF sandbox**, **ADAS sandbox**, or **Default profile** from **Connection preset / local profile**. The field also accepts another profile name typed manually. Set the default database and connect; the disabled Relay/SSH/MySQL fields below it can be ignored.

## Add a fully UI-managed connection

In the connection editor:

1. Open **Advanced** and enable **Use custom advanced Relay, SSH and MySQL settings**.
2. Fill the relay command, one relay argument per row, prompt patterns, SSH target, and MySQL host/port.
3. For each required credential, enter only the environment-variable name, such as `DBGATE_MYSQL_WAF_PASSWORD`—never its value.
4. Set **Default database** on the General tab if the connection should open one database by default.
5. Use **Test**, then **Save** or **Connect**.

DbGate may satisfy **Test** from the plugin's local configuration without opening Relay, specifically to avoid background Touch ID prompts. Expanding the database tree or running the first `SELECT 1` is the authoritative end-to-end route check.

Export the named secret values in the shell that starts DbGate:

```bash
export DBGATE_RELAY_WAF_PASSWORD='...'
export DBGATE_SSH_WAF_PASSWORD='...'
export DBGATE_MYSQL_WAF_USER='...'
export DBGATE_MYSQL_WAF_PASSWORD='...'
npm run start:local
```

If relay or SSH authentication is already handled by the surrounding session, leave the corresponding password-environment-variable field empty. Do not place credentials in relay arguments; process arguments may be visible to other local processes.

DbGate saves the non-secret routing fields and environment-variable names in its local connection record. On connect, the plugin writes that non-secret profile to a private temporary file for the bundled runner, resolves credential values from the DbGate process environment, and removes the file when the connection closes.

## `profiles.json` compatibility mode

Existing file-based profiles remain supported. Leave **Use custom advanced Relay, SSH and MySQL settings** disabled and select or type the profile key in **Connection preset / local profile**.

Copy `config/profile.example.json` to the default private location:

```bash
mkdir -p ~/.config/dbgate-relay-mysql
cp config/profile.example.json ~/.config/dbgate-relay-mysql/profiles.json
chmod 600 ~/.config/dbgate-relay-mysql/profiles.json
```

Edit only the non-secret routing and prompt fields in that file. The example uses the profile key `default` and invokes `relay-cli login -u your-relay-user`; adjust the relay username, executable path, relay/SSH targets, and prompt patterns to match the actual environment. Profile files must be regular, user-owned files with no group or other permissions. Inline passwords are rejected.

Secret values are resolved from environment variables named by the profile:

```bash
export DBGATE_RELAY_DEFAULT_PASSWORD='...'
export DBGATE_SSH_DEFAULT_PASSWORD='...'
export DBGATE_MYSQL_DEFAULT_USER='...'
export DBGATE_MYSQL_DEFAULT_PASSWORD='...'
npm run start:local
```

If relay or SSH authentication is already handled by the surrounding session, omit the corresponding `*PasswordEnv` field.

To keep the profile elsewhere, set `DBGATE_RELAY_MYSQL_PROFILE_FILE` to its absolute path before starting DbGate. Do not commit the profile or secret environment files.

The remaining connection settings are the same in both modes:

- **Default database** is optional and controls which database opens by default. The left tree still discovers and lists every permitted non-system database through the persistent Relay/SSH session.
- **Runner executable path** is normally empty, which uses the bundled persistent-session broker. A custom runner path retains the legacy one-shot behavior.
- **Query timeout** defaults to 30,000 ms. It includes Relay/SSH authentication when a new session is needed and the remote MySQL execution.

The form deliberately has no relay, SSH, or MySQL password-value fields. Separate DbGate connections may use separate routing settings and environment-variable names.

The same real connection can be injected at startup instead of saved through the UI:

```bash
CONNECTIONS=relay \
ENGINE_relay='relay-mysql@dbgate-plugin-relay-mysql' \
LABEL_relay='Relay MySQL' \
READONLY_relay=1 \
CONNECTION_relay_relayProfile=default \
CONNECTION_relay_timeoutMs=30000 \
npm run start:local
```

Do not set `CONNECTION_relay_runnerPath` for normal use; leaving it empty selects the bundled real runner.

## Test fixture versus real data

`npm run test:e2e` always starts a connection named **Relay fixture** with `fixture_db` and `wide_table`. Those rows come from `test/fixtures/fake-runner.js`; they verify the DbGate tree, grid, SQL editor, and plugin protocol without contacting a company endpoint.

If those names appear in the UI, that server is the automated test server, not a real relay session. Stop it and run `npm run start:local` with a private profile and a normal Relay MySQL connection. A real connection must not point its runner path at `test/fixtures/fake-runner.js`.

## Query policy

Exactly one statement is accepted. Write statements, DDL, `CALL`, `SET`, `USE`, transactions, `SELECT ... INTO`, locking reads, executable comments, assignment, high-risk functions, and active mysql client commands are rejected before the runner starts.

A manual `SELECT` without a top-level limit is executed with a 5,001-row probe; only 5,000 rows are shown. An explicit limit above 5,000 is rejected. Table tabs are separate: DbGate sends `LIMIT 100 OFFSET n` by default and the plugin adds deterministic primary-key ordering when metadata supplies a primary key.

Cancellation is local and best effort. Cancelling or timing out a query destroys its Relay/SSH session so that the remote process cannot be reused; the next query authenticates again. MySQL and SQL errors keep a healthy session available. A session also authenticates again after one hour idle, a network disconnect, a broker/DbGate restart, or a profile change.

## Verify

```bash
npm test
npm run build
npm run test:e2e
npm run plugin:install-local -- --clean
```

The E2E suite installs the plugin into an unmodified local DbGate 7.2.1 instance and uses a synthetic runner—never a company endpoint or real credential. It runs in `.local/dbgate-e2e`, separate from the normal `.local/dbgate` workspace.

For an explicitly configured real profile, run the synthetic, non-sensitive smoke query:

```bash
npm run smoke:relay -- --profile default
```

Use `--profile-file /absolute/path/profiles.json`, `--timeout-ms 30000`, or `--runner /absolute/path/to/runner` when needed. The smoke command reports only status, duration, and an opaque query ID; it does not print SQL, XML, or result values.

## Security notes

- Success stdout is complete XML only; failure stdout is empty and stderr is one sanitized JSON object.
- SQL is sent to the runner over stdin in bounded Base64 frames, never in its process arguments.
- Relay, SSH, and MySQL credential values are not stored in DbGate connection records; UI-managed records contain only environment-variable names.
- The persistent broker uses a user-owned `0700` runtime directory and a `0600` Unix socket. Credential values exist only in the broker environment and live session memory.
- Raw PTY transcripts, SQL, XML, result values, and credentials are not logged by this plugin.
- The remote mysql process receives its password through `MYSQL_PWD`; this avoids argv exposure but is not a substitute for a least-privilege account.
- Binary values and XML-invalid control bytes are unsupported in the MVP. Query binary values explicitly with `HEX(column)`.

## License

GPL-3.0-only.
