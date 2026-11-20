# Changelog

本项目的所有重要变更均记录在此文件中。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## Unreleased

- 实时模型发现同时观察 AGY 的会话窗口，新模型无需逐版补表；无法确认容量时保留本地预算，不再每次请求提示。过大的旧注册预算仍在提交前拒绝。

## [0.1.0] - 2026-11-19

首个预发布版本。提供基于 Bun 的官方 Antigravity CLI（`agy`）双向 ACP/MCP 桥接实现，支持零 OMP 依赖的独立核心库入口与 OMP `18.13.1` 扩展适配器。

### Added

- **双入口架构**：
  - `omp-agy/core`（[core.ts](core.ts)）：不依赖 `@oh-my-pi/*` 的独立 Bun 库入口，导出 `Agent`、`SessionController`、`discoverModels`、`bootstrapRunner` 等会话与生命周期原语，并附带独立可运行示例 [examples/standalone.ts](examples/standalone.ts)。
  - `omp-agy`（[index.ts](index.ts)）：面向 OMP `18.13.1` 的标准 provider 扩展入口，将 `@oh-my-pi/*` 声明为可选 `peerDependencies`。
- **多运行后端与严格准入**：
  - **Windows 专用 WSL2 模式（`wsl`，默认）**：固定对接 `omp-agy-wsl` 发行版与非 root 用户 `agy`，由独立 Linux 监督器（[scripts/bootstrap.sh](scripts/bootstrap.sh)、[scripts/supervisor.sh](scripts/supervisor.sh)）管理私有激活目录、网关路由核验、stdio 协议流与持久清理收据。
  - **POSIX 原生模式（`native`，显式启用）**：面向 Linux 与 macOS 本机已认证 `agy` 可执行文件（[src/runner-native.ts](src/runner-native.ts)），使用私有临时配置树、loopback MCP 绑定与进程组级退出确认。
  - **自定义 Runner 注入**：核心库支持通过 `Agent.open({ bootstrap })` 接入宿主自定义进程启动与回收实现。
- **三种 Prompt Profile**：
  - `custom-clean`（默认）：隔离官方默认自定义组件，不转发 OMP 独立系统提示词。
  - `default-agy`：保留官方默认代理行为，支持通过 `OMP_AGY_INSTRUCTIONS` 追加显式指令。
  - `omp-system`：显式选择时将当前调用的宿主系统提示词与 MCP 工具映射说明写入当次激活私有的主代理定义。
- **实时模型发现、原生思维档位与上下文预算**：
  - 支持按需实时发现（`ondemand`，默认）与显式启动期发现（`OMP_AGY_DISCOVERY=startup`），不使用持久化假模型缓存。
  - 逐模型读取并校验 ACP `thought_level` 选项，映射至 OMP 原生思维选择器（如 `low` / `medium` / `high` / `xhigh`），在空闲边界经 `session/set_config_option` 确认后才发起生成。
  - 内置 CLI `1.5.10` 逐模型参考上下文上限表（[src/context-limits.ts](src/context-limits.ts)），支持 `OMP_AGY_CONTEXT_WINDOW` 本地预算夹紧，并在状态栏分离显示 `AGY ctx` 原生窗口与 `OMP` 预算。
- **配额查询、交互命令与有界调试跟踪**：
  - WSL 模式支持受监督的非生成式 `agy -p /usage --output-format json` 账户组配额读取，同时提供独立多行状态组件与 OMP 原生 `/usage` `UsageProvider` 报告。
  - 注册 `/agy`、`/agy-discover`、`/agy-status`、`/agy-profile`、`/agy-login`（[scripts/account-login.sh](scripts/account-login.sh) 专用 WSL 前台账号切换）、`/agy-stop`、`/agy-reset`、`/agy-debug` 命令。
  - 默认关闭的有界双向协议跟踪 `DebugTrace`（[src/debug.ts](src/debug.ts)），支持 `metadata` 与显式 `content` 模式、结构哈希、凭据脱敏及单条/总量截断标记。
- **工程化与发布检查**：
  - 补充 MIT [LICENSE](LICENSE)、LF 行尾约束 [.gitattributes](.gitattributes)、无 OMP 独立消费者打包冒烟脚本 [scripts/check-package.ts](scripts/check-package.ts) 及 Ubuntu / Windows / macOS GitHub Actions 工作流。

### Security & Reliability

- **MCP 桥接认证与窄探测门禁**：每次激活生成独立高熵 Bearer Token，严格校验 `Host`、`Origin`、精确路径、HTTP 方法、JSON-RPC 结构与安全整数边界；仅对 OAuth 受保护资源发现 `GET` 返回空 `404`、对初始化前 `server/discover` `POST` 返回无副作用 `-32601`。
- **控制流与诊断流物理隔离**：WSL 监督器通过独立文件描述符输出控制事件，将 CLI 诊断流经 FIFO 非阻塞分片 Base64 编码回传；`RunnerDiagnosticCapture` 先处理跨分片令牌前缀脱敏再执行 UTF-8 尾部截断。
- **身份核验清理与恢复**：Linux 侧独立落盘世代绑定的清理收据；`/agy-reset` 仅回收经 `boot_id`、PID 启动时间及进程组核验确认已退出的激活，绝不盲杀同名进程或自动重放未完成任务。
- **未知回执实时 Steering 隔离**：流式响应期间的原生 steering 若在获得官方回显或响应前遇阻/超时，既不伪造 `accept()` 也不触发自动 `reject()` 重发，而是持久隔离该精确输入并在激活停止后阻断隐式重放。

### Fixed

- 修复 OMP 图片预算裁剪（覆盖 `user`、`developer`、`toolResult`、`compactionSummary` 归档帧及纯图片消息省略占位文本）引发的误判上下文变更与重复会话重建。
- 修复 OMP 原生 `/usage` 报告中同配额组多窗口（`5h` / `weekly`）被 `sharedGroup` 折叠丢失、缺少 `usedFraction` 导致显示 `unknown used` 的问题，并增加采样时间戳提示。
- 修复状态栏配额请求因切换模型或重绑被主动取消后误入 60 秒冷却锁定的问题，保留真实失败退避并串行等待旧 producer 清理。
- 修复边界 steering 等待期间新到达 MCP 工具请求的即时中止移交、活跃工具回填期间切换 thinking 档位的异常隔离、空白 `OMP_AGY_CONTEXT_WINDOW` 解析报错，以及废弃分支损坏隔离记录跨分支误阻断的问题。
- 修复 `setProfile` 自等待、取消发现后的状态归属、MCP 撤销后递送计数及跨会话重放围栏串扰问题。

### Known Limitations

- Windows 默认仅支持专用 WSL2 运行后端，不提供内置 Windows 原生 `agy.exe` 后端或隐式回退。
- `native` 模式不支持 WSL 专属的 `/agy-login`、`/agy-reset` 与受监督 `/usage` 配额查询。
- OMP `18.13.1` 内置 `advisor` 角色使用独立未绑定会话 ID，不支持直接将 `modelRoles.advisor` 指向 `omp-agy`（评审场景请使用 `task` 子代理）。
- 未知回执 steering 被隔离后，若 OMP 将该输入恢复至待发队列，需手动清除该待发项后再提交新的显式输入。
- 包入口直接导出 TypeScript 源码；独立项目对 `omp-agy/core` 执行 `tsc --noEmit` 时需在 `tsconfig.json` 中启用 `"moduleResolution": "Bundler"` 与 `"allowImportingTsExtensions": true`。
