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
