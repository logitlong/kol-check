// 通用 AI 提取器：使用者自带 API key。
// - Claude 走 Anthropic 官方 SDK
// - 其余（GPT、DeepSeek、通义千问、豆包、Gemini、任何 OpenAI 兼容接口）走 /chat/completions
// 判断规则和本机 Claude 提取器共用同一份提示词。
import dns from "node:dns/promises";
import net from "node:net";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { SYSTEM, normalizeResult } from "./claude-cli.js";
import { extractWithRules } from "./rules.js";
import { AppError } from "../errors.js";

// defaultModel 只是示例，各家模型名经常变，使用者可以在页面上改。
export const PROVIDERS = [
  { id: "claude", label: "Claude（Anthropic）", kind: "anthropic", defaultModel: "claude-opus-5-5", vision: true,
    models: ["claude-opus-5-5", "claude-fable-5-2", "claude-sonnet-5-5", "claude-haiku-5-5"],
    keyUrl: "https://console.anthropic.com/settings/keys", keyHint: "sk-ant- 开头" },
  { id: "openai", label: "GPT（OpenAI）", kind: "openai", baseUrl: "https://api.openai.com/v1", defaultModel: "gpt-4o-mini", vision: true,
    keyUrl: "https://platform.openai.com/api-keys", keyHint: "sk- 开头" },
  { id: "deepseek", label: "DeepSeek", kind: "openai", baseUrl: "https://api.deepseek.com", defaultModel: "deepseek-flash", vision: true,
    keyUrl: "https://platform.deepseek.com/api_keys", keyHint: "sk- 开头；deepseek-flash 能看图，deepseek-v4-pro 不能" },
  { id: "qwen", label: "通义千问（阿里云百炼）", kind: "openai", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", defaultModel: "qwen-plus", vision: false,
    keyUrl: "https://bailian.console.aliyun.com/?tab=model#/api-key", keyHint: "sk- 开头；要看图请把模型换成 qwen-vl 系列" },
  { id: "doubao", label: "豆包（火山方舟）", kind: "openai", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", defaultModel: "", vision: false,
    keyUrl: "https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey", keyHint: "模型一栏填方舟后台的模型名或接入点 ID（ep- 开头）" },
  { id: "gemini", label: "Gemini（Google）", kind: "openai", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", defaultModel: "gemini-2.5-flash", vision: true,
    keyUrl: "https://aistudio.google.com/apikey", keyHint: "AIza 开头" },
  { id: "custom", label: "其他（OpenAI 兼容接口）", kind: "openai", baseUrl: "", defaultModel: "", vision: false,
    keyUrl: "", keyHint: "需要填接口地址，例如 https://api.example.com/v1" },
];

const TEXT_BATCH = 30, IMAGE_BATCH = 8, MAX_IMAGES_PER_POST = 2, CONCURRENCY = 3;

/** 这类错误重试也没用，要直接告诉使用者。 */
class FatalAiError extends AppError {}

const JSON_SPEC = `

【输出格式】只输出一个 JSON 对象，不要任何解释文字，不要 Markdown 代码块。结构如下：
{
  "calls": [
    {
      "post_id": "帖子 id（字符串）",
      "symbol": "Yahoo Finance 代码",
      "symbol_confident": true,
      "kind": "view 或 exit",
      "direction": "bull 或 bear",
      "horizon_days": 5,
      "horizon_stated": true,
      "conviction": "low、medium 或 high",
      "from_image": false,
      "note": "一句话依据"
    }
  ],
  "profit_flex_post_ids": ["晒收益帖子的 id"]
}
没有任何观点时输出 {"calls": [], "profit_flex_post_ids": []}。`;

const IMAGE_NOTE = "\n\n（这批帖子的图片已直接附在本条消息里，每组图片前标了对应的帖子 id。你没有也不需要 Read 工具，直接看图即可。）";

const ZSchema = z.object({
  calls: z.array(z.object({
    post_id: z.string(), symbol: z.string(), symbol_confident: z.boolean(),
    kind: z.enum(["view", "exit"]), direction: z.enum(["bull", "bear"]),
    horizon_days: z.number(), horizon_stated: z.boolean(),
    conviction: z.enum(["low", "medium", "high"]), from_image: z.boolean(), note: z.string(),
  })),
  profit_flex_post_ids: z.array(z.string()),
});

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  const v = ip.toLowerCase();
  return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80") || v.startsWith("::ffff:");
}

/** 自定义接口地址的检查：线上部署时不允许让服务器去请求内网地址。 */
async function resolveBaseUrl(provider, customBaseUrl) {
  if (provider.id !== "custom") return provider.baseUrl;
  let u;
  try {
    u = new URL(String(customBaseUrl || "").trim());
  } catch {
    throw new FatalAiError("ai_url_bad", "接口地址格式不对，应类似 https://api.example.com/v1");
  }
  if (process.env.HOSTED) {
    if (u.protocol !== "https:") throw new FatalAiError("ai_url_https", "接口地址必须以 https:// 开头");
    const addrs = net.isIP(u.hostname) ? [{ address: u.hostname }] : await dns.lookup(u.hostname, { all: true }).catch(() => []);
    if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) throw new FatalAiError("ai_url_blocked", "这个接口地址无法使用");
  } else if (!/^https?:$/.test(u.protocol)) {
    throw new FatalAiError("ai_url_bad", "接口地址必须以 http:// 或 https:// 开头");
  }
  return u.toString().replace(/\/+$/, "");
}

function imageUrl(src) {
  if (!/^https:\/\/pbs\.twimg\.com\//.test(src)) return null; // 只把 X 自己的图片地址交给 AI
  return src.includes("?") ? src : `${src}?name=small`;
}

const LANG_NAMES = { "zh-CN": "简体中文", "zh-TW": "繁體中文", en: "English", ja: "日本語", ko: "한국어", es: "Español", pt: "Português" };
export const noteLangLine = (lang) => (LANG_NAMES[lang] && lang !== "zh-CN" ? `\n\n（note 字段请用 ${LANG_NAMES[lang]} 书写。）` : "");

function buildPayload(batch, withImages) {
  return batch.map((p) => ({
    id: String(p.id), date: p.createdAt.slice(0, 10), text: p.text,
    ...(p.quoted ? { quoted: p.quoted } : {}),
    ...(withImages && p._imgs?.length ? { images: `见下方附图（${p._imgs.length} 张）` } : {}),
  }));
}

function parseJsonLoose(text) {
  const s = String(text ?? "").replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  try {
    return JSON.parse(s);
  } catch {}
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a !== -1 && b > a) return JSON.parse(s.slice(a, b + 1));
  throw new Error("AI 返回的不是合法 JSON");
}

async function callAnthropic({ apiKey, model, effort, lang }, batch, withImages) {
  const client = new Anthropic({ apiKey, maxRetries: 4 });
  const content = [{ type: "text", text: JSON.stringify(buildPayload(batch, withImages)) + (withImages ? IMAGE_NOTE : "") + noteLangLine(lang) }];
  if (withImages) {
    for (const p of batch) {
      if (!p._imgs?.length) continue;
      content.push({ type: "text", text: `帖子 ${p.id} 的图片：` });
      for (const url of p._imgs) content.push({ type: "image", source: { type: "url", url } });
    }
  }
  try {
    const response = await client.messages.parse({
      model, max_tokens: 16000,
      thinking: { type: "adaptive" },
      output_config: { effort: effort || "low", format: zodOutputFormat(ZSchema) },
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content }],
    });
    if (response.stop_reason === "refusal" || !response.parsed_output) throw new Error("模型没有返回结果");
    return response.parsed_output;
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) throw new FatalAiError("ai_key", "Claude API key 无效或没有权限，请检查后重新填写");
    if (e instanceof Anthropic.NotFoundError) throw new FatalAiError("ai_model", `Claude 没有「${model}」这个模型，请换一个`, { model });
    if (e instanceof Anthropic.BadRequestError && /credit balance/i.test(e.message)) throw new FatalAiError("ai_balance", "Claude API 账户余额不足，请先到 Anthropic 后台充值");
    throw e;
  }
}

async function callOpenAICompatible({ apiKey, model, baseUrl, lang }, batch, withImages) {
  let userContent = JSON.stringify(buildPayload(batch, withImages)) + noteLangLine(lang);
  if (withImages) {
    const parts = [{ type: "text", text: userContent + IMAGE_NOTE }];
    for (const p of batch) {
      if (!p._imgs?.length) continue;
      parts.push({ type: "text", text: `帖子 ${p.id} 的图片：` });
      for (const url of p._imgs) parts.push({ type: "image_url", image_url: { url } });
    }
    userContent = parts;
  }
  const body = {
    model,
    messages: [{ role: "system", content: SYSTEM + JSON_SPEC }, { role: "user", content: userContent }],
    response_format: { type: "json_object" },
  };
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST", redirect: "error",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body), signal: AbortSignal.timeout(180000),
      });
    } catch (e) {
      if (attempt < 2) continue;
      throw new Error(`连不上 AI 接口：${e.message}`);
    }
    if (res.ok) {
      const json = await res.json();
      const text = json?.choices?.[0]?.message?.content;
      if (!text) throw new Error("AI 返回为空");
      return parseJsonLoose(Array.isArray(text) ? text.map((t) => t.text ?? "").join("") : text);
    }
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    // 只认明确的余额错误；以前凡是带 quota/balance 字样（比如限流提示）都被误报成“余额不足”
    const short = detail.replace(/\s+/g, " ").slice(0, 160);
    if (res.status === 402 || /insufficient[ _]balance|insufficient_quota|credit balance|arrearage|Arrearage|欠费|余额不足/i.test(detail)) throw new FatalAiError("ai_balance", "AI 账户余额或额度不足，请到对应后台充值", { status: res.status, detail: short });
    if (res.status === 401 || res.status === 403) throw new FatalAiError("ai_key", "AI 的 API key 无效或没有权限，请检查是否填对、是否选对了服务商", { status: res.status, detail: short });
    if (res.status === 404 || /model.*(not|does not) (found|exist)|invalid model|模型不存在/i.test(detail)) throw new FatalAiError("ai_model", `模型名「${model}」或接口地址不对，请对照服务商后台检查`, { model, status: res.status, detail: short });
    // 有的服务商不支持 response_format，去掉再试一次
    if (res.status === 400 && body.response_format && /response_format|json_object/i.test(detail)) {
      delete body.response_format;
      continue;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
      continue;
    }
    throw new Error(`AI 接口返回 ${res.status}：${detail}`);
  }
}

/**
 * ai: { provider, apiKey, model, baseUrl?, effort?, vision? }
 * 返回 { calls, flexIds, failedBatches, uncertain, imagePosts, label }
 */
export async function extractWithApi(posts, ai, { onProgress } = {}) {
  const provider = PROVIDERS.find((p) => p.id === ai.provider);
  if (!provider) throw new AppError("ai_provider", "不认识的 AI 服务商");
  const model = String(ai.model || provider.defaultModel || "").trim();
  if (!model) throw new AppError("ai_model_empty", "请填写模型名");
  if (!/^[\w.\-:/@]{1,120}$/.test(model)) throw new AppError("ai_model_chars", "模型名里有不支持的字符");
  if (provider.kind === "anthropic" && !provider.models.includes(model)) throw new AppError("ai_model_claude", "请从列表里选择 Claude 模型");
  const cfg = { apiKey: ai.apiKey, model, effort: ai.effort, lang: ai.lang, baseUrl: provider.kind === "openai" ? await resolveBaseUrl(provider, ai.baseUrl) : undefined };
  const call = provider.kind === "anthropic" ? callAnthropic : callOpenAICompatible;

  const useVision = Boolean(ai.vision);
  const prepared = posts.map((p) => ({ ...p, _imgs: useVision ? (p.images ?? []).map(imageUrl).filter(Boolean).slice(0, MAX_IMAGES_PER_POST) : [] }));
  const withImg = prepared.filter((p) => p._imgs.length);
  const textOnly = prepared.filter((p) => !p._imgs.length);
  const batches = [];
  for (let i = 0; i < textOnly.length; i += TEXT_BATCH) batches.push({ posts: textOnly.slice(i, i + TEXT_BATCH), withImages: false });
  for (let i = 0; i < withImg.length; i += IMAGE_BATCH) batches.push({ posts: withImg.slice(i, i + IMAGE_BATCH), withImages: true });

  const calls = [], flexIds = [];
  let failedBatches = 0, uncertain = 0, done = 0, imageFallbacks = 0, lastError = null, fatal = null;
  const queue = [...batches];
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length && !fatal) {
      const batch = queue.shift();
      const ids = new Set(batch.posts.map((p) => String(p.id)));
      try {
        let data;
        try {
          data = await call(cfg, batch.posts, batch.withImages);
        } catch (e) {
          if (e instanceof FatalAiError || !batch.withImages) throw e;
          imageFallbacks++; // 看图失败（模型不支持图片或图片取不到）：这一批退回只看文字
          data = await call(cfg, batch.posts, false);
        }
        const r = normalizeResult(data, ids);
        calls.push(...r.calls);
        flexIds.push(...r.flexIds);
        uncertain += r.uncertain;
      } catch (e) {
        if (e instanceof FatalAiError) { fatal = e; break; }
        failedBatches++;
        lastError = e;
        console.error("[ai] 批次失败，退回规则提取：", e.message);
        calls.push(...(await extractWithRules(batch.posts)));
      }
      done += batch.posts.length;
      onProgress?.(done, posts.length);
    }
  }));
  if (fatal) throw fatal;
  if (batches.length && failedBatches === batches.length) throw new AppError("ai_all_failed", `AI 调用全部失败：${lastError?.message ?? "未知错误"}`, { detail: String(lastError?.message ?? "").slice(0, 200) });
  return {
    calls, flexIds, failedBatches, uncertain,
    imagePosts: withImg.length, imageFallbacks,
    provider: provider.id, model,
  };
}
