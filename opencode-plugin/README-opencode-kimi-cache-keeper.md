# kimi-cache-keeper for opencode — 安装指南

> 面向人类与 AI agent 的自包含安装手册。
> 作用：每 15 分钟向近期活跃且空闲的 opencode 会话注入一条微型保活消息，
> 维持服务端 prompt 前缀缓存，避免长时间空闲后每次开口全量重算输入、降低 token 成本。
> 本项目是 https://github.com/RooKichenn/kimi-cache-keeper（Kimi Code Skill）的
> opencode 兼容改写版。由于opencode没有cron定时任务机制，只能使用插件来实现该功能。

---

## 1. 安装（唯一必需步骤）

把下方 **完整插件源码** 原样保存为以下文件（目录不存在就先创建）：

```text
~/.config/opencode/plugins/kimi-cache-keeper.js
```

- Windows 等价路径：`C:\Users\<用户名>\.config\opencode\plugins\kimi-cache-keeper.js`
- **不需要**修改 `opencode.json`：该目录下的 `.js` / `.ts` 文件会被 opencode 全局自动发现并加载。
- 保存后 **完全退出并重启 opencode**（插件只在启动时加载，当前会话不会热更新）。

### Agent 执行检查清单

1. 确认父目录存在：`Test-Path ~/.config/opencode/plugins`（不存在则 `New-Item -ItemType Directory`）
2. 将第 3 节源码写入 `~/.config/opencode/plugins/kimi-cache-keeper.js`（UTF-8，无 BOM 改动即可）
3. 语法冒烟：`node --input-type=module --check < path`，或直接 `import()` 该文件调用一次默认导出
4. 提醒用户重启 opencode
5. 重启后按第 4 节验证日志出现 `keep-alive armed`

---

## 2. 配置（可选，均有默认值）

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `KIMI_CACHE_KEEPER_INTERVAL_MINUTES` | `15` | 心跳间隔（分钟），最小 1 |
| `KIMI_CACHE_KEEPER_ENABLED` | 启用 | 设为 `false` / `0` / `off` 临时关闭 |

在启动 opencode 的 shell 中设置即可，例如 PowerShell：

```powershell
$env:KIMI_CACHE_KEEPER_INTERVAL_MINUTES = "12"
```

---

## 3. 插件源码（完整，逐字复制）

```javascript
// kimi-cache-keeper — opencode-compatible adaptation of
// https://github.com/RooKichenn/kimi-cache-keeper
//
// 原理: Kimi 等 OpenAI 兼容服务端对会话输入做前缀缓存。两次请求前缀一致且
// 间隔落在缓存窗口内时, 输入按缓存价计费; 否则全量重算。本插件每隔 N 分钟
// 向"近期活跃且当前空闲"的会话注入一条微型保活消息, 模型简短回复后即结束,
// 用极小开销把会话前缀维持在缓存窗口内。
//
// 与原 Kimi Code Skill 的对应关系:
//   原 CronCreate 定时任务      -> setInterval 定时器
//   固定微型保活文本            -> HEARTBEAT_TEXT
//   会话绑定                    -> 跟踪本会话项目内近期活跃的 session
//   忙碌时顺延                  -> session.status 忙时跳过(忙碌会话自身请求已在保温)
//   新会话需重新开启            -> 本项目内所有近期活跃会话自动覆盖(含 orchestrator 与子任务会话)
//
// 配置(可选环境变量, 默认即开即用, 无需修改):
//   KIMI_CACHE_KEEPER_INTERVAL_MINUTES  心跳间隔分钟数, 默认 15
//   KIMI_CACHE_KEEPER_ENABLED           "false" 可临时关闭, 默认启用
//
// 放置于 ~/.config/opencode/plugins/ 后会被自动发现加载, 无需在 opencode.json
// 中注册。修改后需重启 opencode 生效。

const DEFAULT_INTERVAL_MINUTES = 15;

const HEARTBEAT_TEXT =
  "【缓存保活】请仅回复两个字:收到。不要执行任何其他操作、不要使用工具。";

const PRUNE_AFTER_MS = 2 * 60 * 60 * 1000; // 两小时未见活动的会话从跟踪表移除

function resolveIntervalMinutes() {
  const raw = process.env.KIMI_CACHE_KEEPER_INTERVAL_MINUTES;
  const parsed = raw ? Number(raw) : Number.NaN;
  if (Number.isFinite(parsed) && parsed >= 1) return Math.floor(parsed);
  return DEFAULT_INTERVAL_MINUTES;
}

function resolveEnabled() {
  const raw = process.env.KIMI_CACHE_KEEPER_ENABLED;
  if (!raw) return true;
  return !["0", "false", "no", "off"].includes(raw.toLowerCase());
}

function extractSessionId(eventType, properties) {
  if (!properties || typeof properties !== "object") return null;
  if (typeof properties.sessionID === "string") return properties.sessionID;
  const info = properties.info;
  if (info && typeof info === "object") {
    if (typeof info.sessionID === "string") return info.sessionID;
    if (eventType === "session.created" && typeof info.id === "string") return info.id;
  }
  return null;
}

export default async function KimiCacheKeeper({ client, directory }) {
  const enabled = resolveEnabled();
  const intervalMinutes = resolveIntervalMinutes();
  const intervalMs = intervalMinutes * 60 * 1000;

  const lastActivity = new Map(); // sessionID -> ms timestamp
  const busy = new Map();         // sessionID -> boolean
  const inFlight = new Set();     // 防止同一会话心跳重入

  const log = (level, message, extra = undefined) =>
    client.app
      .log({
        body: { service: "kimi-cache-keeper", level, message, extra },
      })
      .catch(() => {});

  if (!enabled) {
    await log("info", "disabled via KIMI_CACHE_KEEPER_ENABLED");
    return {};
  }

  async function heartbeat(sessionID) {
    if (inFlight.has(sessionID)) return;
    inFlight.add(sessionID);
    try {
      await client.session.promptAsync({
        path: { id: sessionID },
        body: { parts: [{ type: "text", text: HEARTBEAT_TEXT }] },
      });
      await log("debug", "heartbeat sent", { sessionID, directory });
    } catch (error) {
      await log("warn", "heartbeat failed", {
        sessionID,
        error: String(error && error.message ? error.message : error),
      });
    } finally {
      inFlight.delete(sessionID);
    }
  }

  async function tick() {
    const now = Date.now();
    // 清理长期未见活动的会话
    for (const [sid, ts] of lastActivity) {
      if (now - ts > PRUNE_AFTER_MS) {
        lastActivity.delete(sid);
        busy.delete(sid);
      }
    }
    const candidates = [];
    for (const [sid, ts] of lastActivity) {
      const idleFor = now - ts;
      // 只对近期活跃会话保活; 超窗缓存已冷, 不为无人返回的会话付费重启
      if (idleFor > intervalMs) continue;
      if (busy.get(sid)) continue; // 忙碌会话自身请求已在保温, 跳过
      candidates.push(sid);
    }
    for (const sid of candidates) {
      await heartbeat(sid);
    }
  }

  const timer = setInterval(() => {
    tick().catch((error) =>
      log("warn", "tick failed", {
        error: String(error && error.message ? error.message : error),
      }),
    );
  }, intervalMs);
  // 不阻塞 Bun/Node 进程退出
  if (typeof timer.unref === "function") timer.unref();

  log("info", "keep-alive armed", {
    intervalMinutes,
    directory,
  });

  return {
    event: async ({ event }) => {
      const props = event && event.properties;
      const sid = extractSessionId(event ? event.type : "", props);
      if (sid) {
        lastActivity.set(sid, Date.now());
      }
      if (event && event.type === "session.status" && props) {
        const status = props.status;
        const type = status && status.type;
        if (sid && typeof type === "string") {
          busy.set(sid, type === "busy" || type === "working" || type === "retry");
        }
      }
      if (event && event.type === "session.deleted" && sid) {
        lastActivity.delete(sid);
        busy.delete(sid);
      }
    },
  };
}
```

---

## 4. 验证效果

| 验证项 | 方法 |
|---|---|
| 插件已加载 | 日志搜索 `keep-alive armed`：`~/.local/share/opencode/log/opencode.log` |
| 心跳已发送 | 同一日志搜索 `heartbeat sent`（默认间隔 15 分钟后出现） |
| 会话内消息 | 会话历史中出现 `【缓存保活】请仅回复两个字:收到` |
| 计费差异 | 长时间空闲后再对话，输入扣费为缓存档而非全量档（以实际账单为准） |

## 5. 行为规则（与原 Skill 一致）

- 只对**最近一个间隔内有活动**的会话保活；超窗会话不付费重启；
- **忙碌会话跳过**：其自身请求已在保温；
- 已删除会话自动从跟踪表移除；
- 覆盖项目内所有近期活跃会话（orchestrator 主会话与子任务会话均生效）。

## 6. 卸载 / 临时停用

- 临时停用：设置 `KIMI_CACHE_KEEPER_ENABLED=false` 后重启；
- 彻底卸载：删除 `~/.config/opencode/plugins/kimi-cache-keeper.js` 后重启。

## 7. 常见问题

- **重启后无 `keep-alive armed` 日志**：确认文件位于 `~/.config/opencode/plugins/`（不是项目目录）、后缀为 `.js`、且是完全重启而非恢复会话。
- **日志出现 `heartbeat failed`**：通常是目标会话已删除或网络抖动，插件会在下一跳自动重试，无需处理。
- **成本**：每次心跳约 35 tokens；按 15 分钟间隔全天 ≈ 3k tokens，远低于缓存过期后的全量重算。
- **效果无法从客户端保证**：缓存窗口是服务端行为，随负载波动；本插件只保证按时保温，命中率以官方账单为准。
