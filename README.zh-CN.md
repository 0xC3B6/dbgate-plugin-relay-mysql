# DbGate Relay MySQL 插件

[English](README.md) | 简体中文

`dbgate-plugin-relay-mysql` 是面向 DbGate Web 7.2.1 的只读外部驱动。它保留既有访问链路——本地 `relay-cli`、交互式 Relay Shell、SSH，以及远端 `mysql` 命令行——同时复用 DbGate 的数据库树、SQL 编辑器和数据表格。

插件不会建立直连 MySQL 的 TCP 连接。使用内置 Runner 时，本地私有 Broker 会为每套完整 Profile 保留一个 Relay/SSH 会话，每次查询只在远端启动 `mysql --xml`。会话空闲一小时后回收。这样既能把宽表结果渲染成支持横向滚动和调整列宽的普通表格，也无需每次查询都进行 Touch ID 认证。

## MVP 功能

- 在 DbGate 左侧树中展示有权限的非系统数据库、表、视图和字段。
- 支持只读的 `SELECT`、`SHOW`、`DESC`/`DESCRIBE` 和 `EXPLAIN SELECT`。
- DbGate 表数据页默认每次增量加载 100 行。
- 流式解析 XML，保留 `NULL`、Unicode、XML 实体、换行、制表符和重复字段名。
- 手动查询最多展示 5,000 行，XML 结果固定上限为 32 MiB。
- 每个 DbGate 连接可分别管理 Relay、SSH 和 MySQL 路由配置。
- 本地 DbGate 启动器只监听 `127.0.0.1`。

当前 MVP 已针对 DbGate Web Community 7.2.1 完成测试，暂不承诺兼容其他 DbGate 版本。

## 安装难度

如果已有可用的 Relay Profile，安装难度属于中等：准备 Node.js 和 `expect`、安装插件、注入凭据环境变量，然后在 DbGate 中选择 Profile 即可。最容易出错的部分通常不是插件安装，而是 Relay 提示符、SSH 目标、MySQL 地址以及环境变量名配置。

当前版本面向本地开发和个人使用，还不是双击安装的一体化应用。首次配置完成后，日常使用只需要启动 DbGate 并连接已有 Profile。

## 环境要求

- macOS 或其他类 Unix 本地系统，Node.js 20.9 或更高版本。
- 本地具有 `/usr/bin/expect`、`relay-cli` 和 `ssh`。
- SSH 目标机器具有 `bash`、`base64`，并安装支持 `--xml`、`--quick` 和 `--binary-mode` 的 MySQL CLI。
- 使用真正只有只读权限的 MySQL 账号。

SQL 校验层只用于防止误操作，并不是权限边界。如需硬性保证，应使用不具备写入、DDL、`FILE`、`EXECUTE`、临时表或管理权限的数据库账号。

## 本地开发安装

```bash
npm ci --cache .npm-cache
npm run plugin:install-local -- --clean
npm run start:local
```

然后打开 <http://127.0.0.1:3100>。安装命令会构建外部插件并复制到 `.local/dbgate/plugins`，不会修改或重新构建 DbGate 本身。

`--clean` 只替换已安装的插件目录，会保留 DbGate 已保存的连接和工作区。E2E 测试使用独立的 `.local/dbgate-e2e` 工作区，不会清理正常的 `.local/dbgate` 工作区。

仓库启动器默认把 DbGate 控制台和文件日志级别设为 `warn`，因为 DbGate 的低级别日志会包含 SQL 文本。将 `CONSOLE_LOG_LEVEL`、`FILE_LOG_LEVEL` 或 `LOG_LEVEL` 改为 `info`/`debug` 可能导致 SQL 被持久化到插件之外。DbGate 也可能把 SQL 编辑器和标签页状态保存在正常工作区中，因此 SQL 文本中不应包含凭据。

## 使用本地 Profile 添加连接

启动 DbGate 时不要设置 `CONNECTIONS`、`SINGLE_CONNECTION` 或其他连接注入变量，然后选择 **+ → Connection → Relay MySQL**。DbGate 7.2.1 没有为插件提供独立 Profile 管理页的 API，因此直接使用原生连接列表管理 Profile：一个 Relay MySQL 连接代表一条完整的 Relay/SSH/MySQL 路由。

最简配置方式是保持 **Use custom advanced Relay, SSH and MySQL settings** 关闭，然后在 **Connection preset / local profile** 中选择 **WAF sandbox**、**ADAS sandbox** 或 **Default profile**。也可以手动输入其他 Profile 名称。设置默认数据库后连接即可，下方被禁用的 Relay/SSH/MySQL 字段无需填写。

## 完全通过 UI 管理连接

在连接编辑页中：

1. 打开 **Advanced**，启用 **Use custom advanced Relay, SSH and MySQL settings**。
2. 填写 Relay 命令、每行一个 Relay 参数、提示符正则、SSH 目标，以及 MySQL 地址和端口。
3. 所有凭据字段只填写环境变量名，例如 `DBGATE_MYSQL_WAF_PASSWORD`，绝不能填写密码值。
4. 如果希望连接后默认打开某个数据库，在 General 页设置 **Default database**。
5. 点击 **Test**，然后点击 **Save** 或 **Connect**。

为了避免后台触发 Touch ID，DbGate 的 **Test** 可能只验证插件本地配置，并不实际打开 Relay。展开数据库树或执行第一条 `SELECT 1` 才是权威的端到端链路验证。

在启动 DbGate 的 Shell 中导出对应的凭据：

```bash
export DBGATE_RELAY_WAF_PASSWORD='...'
export DBGATE_SSH_WAF_PASSWORD='...'
export DBGATE_MYSQL_WAF_USER='...'
export DBGATE_MYSQL_WAF_PASSWORD='...'
npm run start:local
```

如果 Relay 或 SSH 认证已由外部会话处理，对应的密码环境变量名可以留空。不要把凭据放进 Relay 参数，进程参数可能被本机其他进程看到。

DbGate 本地连接记录只保存非敏感路由字段和环境变量名。连接时，插件会为内置 Runner 创建仅包含非敏感信息的私有临时 Profile 文件，从 DbGate 进程环境读取凭据值，并在连接关闭时删除临时文件。

## `profiles.json` 兼容模式

插件继续支持已有的文件 Profile。保持 **Use custom advanced Relay, SSH and MySQL settings** 关闭，并在 **Connection preset / local profile** 中选择或输入 Profile Key。

将示例复制到默认私有目录：

```bash
mkdir -p ~/.config/dbgate-relay-mysql
cp config/profile.example.json ~/.config/dbgate-relay-mysql/profiles.json
chmod 600 ~/.config/dbgate-relay-mysql/profiles.json
```

只在文件中编辑非敏感的路由和提示符字段。示例 Profile Key 为 `default`，并执行 `relay-cli login -u your-relay-user`；请根据实际环境调整 Relay 用户名、可执行文件路径、Relay/SSH 目标和提示符正则。Profile 文件必须是当前用户拥有的普通文件，组用户和其他用户不能有访问权限。插件会拒绝内联密码。

Profile 中只保存环境变量名，凭据值从环境变量读取：

```bash
export DBGATE_RELAY_DEFAULT_PASSWORD='...'
export DBGATE_SSH_DEFAULT_PASSWORD='...'
export DBGATE_MYSQL_DEFAULT_USER='...'
export DBGATE_MYSQL_DEFAULT_PASSWORD='...'
npm run start:local
```

如果 Relay 或 SSH 认证已由外部会话处理，可以省略对应的 `*PasswordEnv` 字段。

如需把 Profile 放在其他位置，请在启动 DbGate 前将 `DBGATE_RELAY_MYSQL_PROFILE_FILE` 设置为该文件的绝对路径。不要提交 Profile 或包含凭据的环境文件。

两种模式的其余连接设置相同：

- **Default database** 可选，只决定默认打开哪个数据库；左侧树仍会通过持久 Relay/SSH 会话发现并展示所有有权限的非系统数据库。
- **Runner executable path** 通常留空，此时使用内置持久会话 Broker。填写自定义 Runner 路径时会保留旧版的一次性执行行为。
- **Query timeout** 默认 30,000 毫秒。当需要建立新会话时，超时范围包含 Relay/SSH 认证和远端 MySQL 执行。

表单不会提供 Relay、SSH 或 MySQL 密码值字段。不同 DbGate 连接可以使用不同的路由设置和环境变量名。

也可以在启动时注入真实连接，而不是通过 UI 保存：

```bash
CONNECTIONS=relay \
ENGINE_relay='relay-mysql@dbgate-plugin-relay-mysql' \
LABEL_relay='Relay MySQL' \
READONLY_relay=1 \
CONNECTION_relay_relayProfile=default \
CONNECTION_relay_timeoutMs=30000 \
npm run start:local
```

正常使用时不要设置 `CONNECTION_relay_runnerPath`，留空才会选择内置真实 Runner。

## 测试数据与真实数据

`npm run test:e2e` 始终启动一个名为 **Relay fixture** 的连接，其中包含 `fixture_db` 和 `wide_table`。这些数据来自 `test/fixtures/fake-runner.js`，用于在不访问公司端点和真实凭据的情况下验证 DbGate 数据库树、数据表格、SQL 编辑器和插件协议。

如果 UI 中出现这些名称，说明当前运行的是自动化测试服务，而不是真实 Relay 会话。请停止测试服务，使用私有 Profile 和正常 Relay MySQL 连接执行 `npm run start:local`。真实连接不能把 Runner 路径指向 `test/fixtures/fake-runner.js`。

## 查询策略

插件只接受一条语句。写入语句、DDL、`CALL`、`SET`、`USE`、事务、`SELECT ... INTO`、锁定读、可执行注释、赋值、高风险函数和活动的 MySQL 客户端命令会在 Runner 启动前被拒绝。

没有顶层 Limit 的手动 `SELECT` 会以 5,001 行进行探测，最终只展示 5,000 行。显式 Limit 超过 5,000 时会被拒绝。表数据页不受此规则影响：DbGate 默认发送 `LIMIT 100 OFFSET n`，当元数据中存在主键时，插件还会补充确定性的主键排序。

取消操作只在本地尽力执行。取消或超时会销毁对应 Relay/SSH 会话，防止继续复用远端进程；下一条查询需要重新认证。MySQL 连接错误和 SQL 错误不会销毁健康会话。会话空闲一小时、网络断开、Broker/DbGate 重启或 Profile 变化后，也会重新认证。

## 验证

```bash
npm test
npm run build
npm run test:e2e
npm run plugin:install-local -- --clean
```

E2E 测试把插件安装到未经修改的本地 DbGate 7.2.1，并使用合成 Runner，不会访问公司端点或真实凭据。测试工作区位于 `.local/dbgate-e2e`，与正常的 `.local/dbgate` 工作区隔离。

对于明确配置的真实 Profile，可以执行只包含合成无敏感查询的冒烟验证：

```bash
npm run smoke:relay -- --profile default
```

需要时可使用 `--profile-file /absolute/path/profiles.json`、`--timeout-ms 30000` 或 `--runner /absolute/path/to/runner`。冒烟命令只报告状态、耗时和不透明 Query ID，不会打印 SQL、XML 或结果值。

## 安全说明

- 成功时 stdout 只包含完整 XML；失败时 stdout 为空，stderr 只包含一个脱敏 JSON 对象。
- SQL 通过 stdin 以有界 Base64 帧发送给 Runner，不会放在进程参数中。
- Relay、SSH 和 MySQL 凭据值不会写入 DbGate 连接记录；UI 管理的记录只包含环境变量名。
- 持久 Broker 使用当前用户拥有的 `0700` 运行目录和 `0600` Unix Socket。凭据值只存在于 Broker 环境和活动会话内存中。
- 插件不会记录原始 PTY Transcript、SQL、XML、查询结果或凭据。
- 远端 MySQL 进程通过 `MYSQL_PWD` 接收密码，避免密码出现在 argv 中，但这不能替代最小权限账号。
- MVP 暂不支持二进制值和 XML 不允许的控制字符。如需查询二进制字段，请显式使用 `HEX(column)`。

## 许可证

GPL-3.0-only。
