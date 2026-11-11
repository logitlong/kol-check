// 整条流水线：取帖子 → 提取观点 → 行情回溯 → 评分。
// 两种运行方式：
// - 本机运行：可以用本机 Claude 和 .env 里的 key
// - 线上部署（环境变量 HOSTED=1）：服务器不存任何 key，全部由使用者在网页上填，随请求带过来，用完即丢
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchFromX, xApiAvailable } from "./sources/x-api.js";
import { fetchFromTwitterApiIo } from "./sources/twitterapi-io.js";
import { extractWithRules } from "./extract/rules.js";
import { extractWithApi, PROVIDERS } from "./extract/ai.js";
import { extractWithClaudeCli, claudeCliAvailable } from "./extract/claude-cli.js";
import { AppError } from "./errors.js";
import { noteLangLine } from "./extract/ai.js";
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
    providers: PROVIDERS.map(({ id, label, kind, defaultModel, models, vision, keyUrl }) => ({ id, label, kind, defaultModel, models, vision, keyUrl })),
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
  const { source, input } = req;
  const lang = typeof req.lang === "string" ? req.lang.slice(0, 8) : "zh-CN";
  const fetchKey = cleanKey(req.fetchKey) || (HOSTED ? "" : process.env.TWITTERAPI_IO_KEY || "");
  const aiKey = cleanKey(req.ai?.apiKey);
  const effort = EFFORTS.find((e) => e.id === (req.ai?.effort ?? req.effort))?.id;
  const maxPosts = Math.max(20, Math.min(10000, Math.round(Number(req.maxPosts)) || Number(process.env.X_MAX_POSTS) || 10000)); // 10000 是"全部"的安全上限

  // —— 1. 取帖子 ——
  let fetched, sourceLabel;
  if (source === "demo") {
    fetched = JSON.parse(await fs.readFile(path.join(ROOT, "data", "demo", "demo_trader.json"), "utf8"));
    sourceLabel = "demo";
  } else {
    const handle = parseHandle(input);
    if (!handle) throw new AppError("bad_handle", "没认出账号，请输入主页链接（https://x.com/xxx）或 @用户名");
    const onProgress = (n, total) => onStage("fetching", { n }, n, total);
    onStage("connect");
    if (fetchKey) {
      fetched = await fetchFromTwitterApiIo(handle, { key: fetchKey, maxPosts, onProgress });
      sourceLabel = "twitterapi";
    } else if (!HOSTED && xApiAvailable()) {
      fetched = await fetchFromX(handle, { maxPosts, onProgress });
      sourceLabel = "x";
    } else {
      throw new AppError("need_fetch_key", "请先在「我的 Key」里填写抓帖 key（twitterapi.io）");
    }
  }
  const { profile, posts } = fetched;
  if (!posts.length) throw new AppError("no_posts", "这个账号没有可分析的帖子");

  // —— 2. 提取观点：使用者填的 AI key → 本机 Claude → 服务器 .env 里的 Claude key → 关键词规则 ——
  let result, kind;
  const onProgress = (d, t) => onStage("reading", { d, t }, d, t);
  onStage("readStart", { n: posts.length }, 0, posts.length);
  if (aiKey) {
    result = await extractWithApi(posts, { ...req.ai, apiKey: aiKey, effort, lang }, { onProgress });
    kind = "api";
  } else if (claudeCliAvailable() && process.env.EXTRACTOR !== "rules") {
    const model = MODELS.find((m) => m.id === req.model)?.id;
    result = await extractWithClaudeCli(posts, { handle: profile.handle, onProgress, model, effort, langLine: noteLangLine(lang) });
    result.model = model || process.env.EXTRACT_MODEL || "claude-opus-5-5";
    kind = "local";
  } else if (!HOSTED && process.env.ANTHROPIC_API_KEY && process.env.EXTRACTOR !== "rules") {
    result = await extractWithApi(posts, { provider: "claude", apiKey: process.env.ANTHROPIC_API_KEY, model: process.env.EXTRACT_MODEL, effort, vision: true, lang }, { onProgress });
    kind = "api";
  } else if (source === "demo" || !HOSTED) {
    result = { calls: await extractWithRules(posts), flexIds: [] };
    kind = "rules";
  } else {
    throw new AppError("need_ai_key", "请先在「我的 Key」里填写 AI 的 API key");
  }
  // 报告里只存结构化信息，文字由页面按访客的语言拼出来
  const extractor = {
    kind, provider: result.provider ?? (kind === "local" ? "claude" : null), model: result.model ?? null,
    imagePosts: result.imagePosts || 0, imageFallbacks: result.imageFallbacks || 0,
    uncertain: result.uncertain || 0, failedBatches: result.failedBatches || 0,
  };

  // —— 3. 行情回溯 + 评分 ——
  onStage("scoring");
  const { calls, horizons, bySymbol, duplicates, exitCount } = await evaluate(posts, result.calls);
  const redFlags = detectRedFlags(posts);
  if (result.flexIds?.length) {
    // 晒收益：事后展示、无法验证，只统计次数，不计入胜率也不额外扣分
    const flex = posts.filter((p) => result.flexIds.includes(String(p.id)));
    redFlags.flags.push({
      id: "flex", count: flex.length,
      examples: flex.slice(0, 3).map((p) => ({ date: p.createdAt.slice(0, 10), text: (p.text || "（仅图片）").slice(0, 160) })),
    });
  }
  const rating = computeScore(horizons, redFlags);
  const dates = posts.map((p) => p.createdAt.slice(0, 10)).sort();

  const report = {
    profile,
    v: 2,
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

  // 只有真实抓取的报告才存下来、出现在"已分析的博主"里（演示数据仅供开发自测，页面上没有入口）
  if (source !== "demo") {
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
      if (r.v !== 2 || !r.profile?.handle) continue;
      out.push({
        handle: r.profile.handle, name: r.profile.name, followers: r.profile.followers,
        score: r.rating?.score ?? null, gradeKey: r.rating?.gradeKey, generatedAt: r.generatedAt,
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
    const r = JSON.parse(await fs.readFile(path.join(REPORT_DIR, `${h.toLowerCase()}.json`), "utf8"));
    return r.v === 2 ? r : null;
  } catch {
    return null;
  }
}
