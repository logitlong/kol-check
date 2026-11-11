// 整条流水线：取帖子 → 提取观点 → 行情回溯 → 评分。
// 两种运行方式：
// - 本机运行：可以用本机 Claude 和 .env 里的 key
// - 线上部署（环境变量 HOSTED=1）：服务器不存任何 key，全部由使用者在网页上填，随请求带过来，用完即丢
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchFromX, xApiAvailable } from "./sources/x-api.js";
import { fetchFromTwitterApiIo } from "./sources/twitterapi-io.js";
import { parseImported } from "./sources/import.js";
import { extractWithRules } from "./extract/rules.js";
import { extractWithApi, PROVIDERS } from "./extract/ai.js";
import { extractWithClaudeCli, claudeCliAvailable } from "./extract/claude-cli.js";
import { evaluate, detectRedFlags, computeScore, HORIZONS, PRIMARY } from "./score.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPORT_DIR = path.join(ROOT, "data", "reports");
const HOSTED = Boolean(process.env.HOSTED);

// 本机 Claude 可选的模型和思考强度
export const MODELS = [
  { id: "claude-opus-5-5", label: "Opus 5.5（默认，均衡）" },
  { id: "claude-fable-5-2", label: "Fable 5.2（最强，最耗额度）" },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5（较快）" },
  { id: "claude-haiku-5-5", label: "Haiku 5.5（最快最省）" },
];
export const EFFORTS = [
  { id: "low", label: "轻度（默认）" },
  { id: "medium", label: "中度" },
  { id: "high", label: "深度（慢，耗额度）" },
];

export function capabilities() {
  return {
    hosted: HOSTED,
    providers: PROVIDERS.map(({ id, label, kind, defaultModel, models, vision, keyUrl, keyHint }) => ({ id, label, kind, defaultModel, models, vision, keyUrl, keyHint })),
    models: MODELS,
    efforts: EFFORTS,
    localClaude: claudeCliAvailable(),
    serverFetchKey: !HOSTED && Boolean(process.env.TWITTERAPI_IO_KEY || xApiAvailable()),
    serverAiKey: !HOSTED && Boolean(process.env.ANTHROPIC_API_KEY),
  };
}

/** "https://x.com/foo/status/1" / "@foo" / "foo" → "foo" */
export function parseHandle(input) {
  const s = String(input || "").trim();
  const m = s.match(/(?:x|twitter)\.com\/@?([A-Za-z0-9_]{1,15})/i) || s.match(/^@?([A-Za-z0-9_]{1,15})$/);
  return m ? m[1] : null;
}

const cleanKey = (v) => {
  const s = String(v ?? "").trim();
  return s && s.length <= 400 && !/\s/.test(s) ? s : "";
};

/**
 * req: { source, input, text, maxPosts, fetchKey, ai: { provider, apiKey, model, baseUrl, vision, effort }, model, effort }
 * onStage(text, done?, total?) 用来向页面汇报进度。
 */
export async function analyze(req, onStage = () => {}) {
  const { source, input, text } = req;
  const fetchKey = cleanKey(req.fetchKey) || (HOSTED ? "" : process.env.TWITTERAPI_IO_KEY || "");
  const aiKey = cleanKey(req.ai?.apiKey);
  const effort = EFFORTS.find((e) => e.id === (req.ai?.effort ?? req.effort))?.id;
  const maxPosts = Math.max(20, Math.min(3200, Math.round(Number(req.maxPosts)) || Number(process.env.X_MAX_POSTS) || 3200));

  // —— 1. 取帖子 ——
  let fetched, sourceLabel;
  if (source === "demo") {
    fetched = JSON.parse(await fs.readFile(path.join(ROOT, "data", "demo", "demo_trader.json"), "utf8"));
    sourceLabel = "演示数据（虚构博主，真实行情）";
  } else if (source === "import") {
    fetched = parseImported(text, parseHandle(input) || "imported");
    sourceLabel = "手动导入";
  } else {
    const handle = parseHandle(input);
    if (!handle) throw new Error("没认出账号，请输入主页链接（https://x.com/xxx）或 @用户名");
    const onProgress = (n, total) => onStage(`正在抓取帖子：已拿到 ${n} 条`, n, total);
    onStage("正在连接抓帖服务…");
    if (fetchKey) {
      fetched = await fetchFromTwitterApiIo(handle, { key: fetchKey, maxPosts, onProgress });
      sourceLabel = "twitterapi.io（第三方）";
    } else if (!HOSTED && xApiAvailable()) {
      fetched = await fetchFromX(handle, { maxPosts, onProgress });
      sourceLabel = "X 官方 API";
    } else {
      throw new Error("请先在「我的 Key」里填写抓帖 key（twitterapi.io）");
    }
  }
  const { profile, posts } = fetched;
  if (!posts.length) throw new Error("这个账号没有可分析的帖子");

  // —— 2. 提取观点：使用者填的 AI key → 本机 Claude → 服务器 .env 里的 Claude key → 关键词规则 ——
  let result, extractor;
  const onProgress = (d, t) => onStage(`AI 正在阅读帖子：${d} / ${t}`, d, t);
  onStage(`共 ${posts.length} 条帖子，AI 开始阅读…`, 0, posts.length);
  const suffix = (r) =>
    (r.imagePosts ? `，含 ${r.imagePosts} 条带图帖子的图片识别` : "") +
    (r.imageFallbacks ? `（其中 ${r.imageFallbacks} 批看图失败，只按文字判断）` : "") +
    (r.uncertain ? `；丢弃了 ${r.uncertain} 条标的代码没把握的观点` : "") +
    (r.failedBatches ? `；有 ${r.failedBatches} 批调用失败，这部分退回了关键词规则` : "");
  if (aiKey) {
    result = await extractWithApi(posts, { ...req.ai, apiKey: aiKey, effort }, { onProgress });
    extractor = result.label + suffix(result);
  } else if (claudeCliAvailable() && process.env.EXTRACTOR !== "rules") {
    const model = MODELS.find((m) => m.id === req.model)?.id;
    result = await extractWithClaudeCli(posts, { handle: profile.handle, onProgress, model, effort });
    const used = MODELS.find((m) => m.id === (model || process.env.EXTRACT_MODEL))?.label.split("（")[0] ?? "Opus 5.5";
    extractor = `本机 Claude · ${used} · ${EFFORTS.find((e) => e.id === (effort || "low")).label.split("（")[0]}` + suffix(result);
  } else if (!HOSTED && process.env.ANTHROPIC_API_KEY && process.env.EXTRACTOR !== "rules") {
    result = await extractWithApi(posts, { provider: "claude", apiKey: process.env.ANTHROPIC_API_KEY, model: process.env.EXTRACT_MODEL, effort, vision: true }, { onProgress });
    extractor = result.label + suffix(result);
  } else if (source === "demo" || !HOSTED) {
    result = { calls: await extractWithRules(posts), flexIds: [] };
    extractor = "关键词规则（没有填 AI key，准确度有限，不看图）";
  } else {
    throw new Error("请先在「我的 Key」里填写 AI 的 API key");
  }

  // —— 3. 行情回溯 + 评分 ——
  onStage("正在回溯行情、计算评分…");
  const { calls, horizons, bySymbol, duplicates, exitCount } = await evaluate(posts, result.calls);
  const redFlags = detectRedFlags(posts);
  if (result.flexIds?.length) {
    // 晒收益：事后展示、无法验证，只统计次数，不计入胜率也不额外扣分
    const flex = posts.filter((p) => result.flexIds.includes(String(p.id)));
    redFlags.flags.push({
      id: "flex", label: "晒收益截图（事后展示，无法验证）", count: flex.length,
      examples: flex.slice(0, 3).map((p) => ({ date: p.createdAt.slice(0, 10), text: (p.text || "（仅图片）").slice(0, 160) })),
    });
  }
  const rating = computeScore(horizons, redFlags);
  const dates = posts.map((p) => p.createdAt.slice(0, 10)).sort();

  const report = {
    profile,
    generatedAt: new Date().toISOString(),
    source: sourceLabel,
    extractor,
    posts: { total: posts.length, withImages: posts.filter((p) => p.images?.length).length, from: dates[0], to: dates[dates.length - 1] },
    callStats: {
      total: calls.length,
      done: calls.filter((c) => c.status === "done").length,
      pending: calls.filter((c) => c.status === "pending").length,
      noData: calls.filter((c) => c.status === "no_data").length,
      duplicatesMerged: duplicates,
      exitSignals: exitCount,
    },
    primaryHorizon: PRIMARY,
    horizonList: HORIZONS,
    rating,
    horizons,
    bySymbol,
    redFlags,
    calls: calls.sort((a, b) => b.date.localeCompare(a.date)),
  };

  // 只有真实抓取的报告才存下来、出现在"已分析的博主"里；粘贴导入的内容无法核实，不公开
  if (source !== "demo" && source !== "import") {
    await fs.mkdir(REPORT_DIR, { recursive: true });
    await fs.writeFile(path.join(REPORT_DIR, `${profile.handle.toLowerCase()}.json`), JSON.stringify(report));
  }
  return report;
}

/** 已分析过的博主列表（按时间倒序）。 */
export async function listReports() {
  let files = [];
  try {
    files = (await fs.readdir(REPORT_DIR)).filter((f) => f.endsWith(".json"));
  } catch {}
  const out = [];
  for (const f of files) {
    try {
      const r = JSON.parse(await fs.readFile(path.join(REPORT_DIR, f), "utf8"));
      if (!r.profile?.handle || !/twitterapi|X 官方/.test(r.source ?? "")) continue;
      out.push({
        handle: r.profile.handle, name: r.profile.name, followers: r.profile.followers,
        score: r.rating?.score ?? null, grade: r.rating?.grade, generatedAt: r.generatedAt,
        posts: r.posts?.total, calls: r.callStats?.total,
      });
    } catch {}
  }
  return out.sort((a, b) => String(b.generatedAt).localeCompare(String(a.generatedAt)));
}

export async function getReport(handle) {
  const h = parseHandle(handle);
  if (!h) return null;
  try {
    return JSON.parse(await fs.readFile(path.join(REPORT_DIR, `${h.toLowerCase()}.json`), "utf8"));
  } catch {
    return null;
  }
}
