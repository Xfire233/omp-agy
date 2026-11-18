# OMP AGY 本机模式

本项目以 OMP 为交互与执行入口，在选定 AGY 的会话中由 Antigravity 提供推理与对话。工具策略、提问、历史和子代理归 OMP 管理。

## Language

**AGY 模式（AGY Mode）**：用户明确选择由 Antigravity 为当前 OMP 会话提供推理与对话的模式；不表示所有子代理都使用同一模型。
_Avoid_：全树 ACP、自动降级路由

**宿主输入（Host-prepared Input）**：OMP 处理后交给选定推理后端的当前消息与上下文，可以包含选中文件、提醒及摘要；不等于编辑器原始字节。
_Avoid_：绝对原文直通、零宿主上下文

**主控会话（Host Conversation）**：用户正在 OMP 中查看和操作的一段对话，决定当前输入属于哪个上下文。

**执行会话（Execution Conversation）**：Antigravity 维护的对话上下文，与主控会话相关联；从宿主历史重建不等于恢复原会话的隐藏状态。
_Avoid_：上下文完全等价

**执行回合（Execution Turn）**：一次用户输入引发的一段 Antigravity 工作，可以包含多次模型请求和工具操作，直到完成、失败或停止。
_Avoid_：一次 HTTP 请求、一次 token 生成

**项目工作区（Project Workspace）**：用户授权 OMP 工具操作的真实项目范围；它与 AGY 自身的运行环境不同，也不天然等于安全隔离。
_Avoid_：CLI 工作目录、沙箱

**工具授权（Tool Authorization）**：OMP 依据现有用户策略决定某次工具操作是否可执行；可以自动允许或拒绝，不必逐次人工确认。

**交互提问（Interactive Question）**：由 OMP 向用户收集任务所需选择或信息，沿用宿主回答、超时与取消策略；不是逐工具审批。

**停止（Stop）**：请求执行者不再继续当前工作；已经写入文件或已发生的外部操作不会因此自动撤销。
_Avoid_：回滚

**激活周期（Activation）**：一个主控会话持续采用同一套 AGY 身份、上下文与能力边界的期间；结束后再启用不意味着恢复原上下文。

**执行边界（Execution Boundary）**：AGY 提出工具请求、OMP 决定授权并承担项目副作用的职责分界。
_Avoid_：提示词约定、身份伪装

**工具目录（Tool Catalog）**：当前模式明确提供给 AGY 的项目操作能力集合；空目录意味着没有项目工具能力。

**提示词配置（Prompt Profile）**：用户选择的 AGY 指令与默认组件政策，区分官方默认行为和用户明确自定义的行为。

**OMP 子代理（OMP Child Agent）**：由 OMP 编排、具有独立任务上下文与角色模型路由的工作单元；需要用户信息时交回父代理提问。
_Avoid_：原生 AGY 子代理、必然继承父模型
