// 规则提取器：没有 Claude API key 时的兜底。只认"明确点名标的 + 明确多空词"的帖子，
// 宁可漏掉也不乱判。准确度明显低于 LLM 提取器。
import { NAME_MAP, normalizeSymbol } from "../symbols.js";

const BULL = [
  "看多", "看涨", "做多", "买入", "加仓", "抄底", "建仓", "上车", "起飞", "突破", "新高", "拿住", "重仓", "梭哈", "低估", "目标价", "要涨", "会涨", "看好", "满仓",
  "買い", "買った", "買い増し", "強気", "上昇", "爆上げ", "仕込み", "押し目", "ロング", "割安",
  "bullish", "buy", "buying", "bought", "long", "calls", "moon", "breakout", "undervalued", "accumulate", "accumulating", "load up", "going higher", "price target",
];
const BEAR = [
  "看空", "看跌", "做空", "卖出", "减仓", "清仓", "逃顶", "泡沫", "崩盘", "要跌", "会跌", "暴跌", "见顶", "高估", "下车", "止盈离场", "别碰", "快跑",
  "売り", "売った", "空売り", "弱気", "下落", "暴落", "天井", "ショート", "割高", "バブル",
  "bearish", "sell", "selling", "sold", "short", "shorting", "puts", "crash", "overvalued", "bubble", "top is in", "dump", "going lower",
];
// 否定/疑问/回顾性的句子不算预测
const SKIP = [/不(是|要|会|建议)?(看多|看空|买|卖)/, /\?\s*$/, /？\s*$/, /^rt @/i, /(复盘|回顾|recap)/i];

const NAME_KEYS = Object.keys(NAME_MAP).sort((a, b) => b.length - a.length);

function findSymbols(text) {
  const found = new Set();
  for (const m of text.matchAll(/\$([A-Za-z]{1,6}(?:[.\-][A-Za-z]{1,4})?)\b/g)) {
    const s = normalizeSymbol(m[1]);
    if (s) found.add(s);
  }
  for (const m of text.matchAll(/\b(\d{6}\.K[SQ]|\d{4}\.T|\d{4}\.HK)\b/gi)) found.add(m[1].toUpperCase());
  // 日股常见写法："7203 トヨタ"、"(7203)"、"<7203>"、"【7203】"
  for (const m of text.matchAll(/[(（<＜【\[](\d{4})[)）>＞】\]]/g)) {
    if (!/^(19|20)\d\d$/.test(m[1])) found.add(m[1] + ".T"); // "(2024)" 这种多半是年份，跳过
  }
  const lower = text.toLowerCase();
  for (const k of NAME_KEYS) {
    const isAscii = /^[\x00-\x7f]+$/.test(k);
    const hit = isAscii ? new RegExp(`(^|[^a-z])${k.replace(/[&.]/g, "\\$&")}([^a-z]|$)`).test(lower) : lower.includes(k);
    if (hit) found.add(NAME_MAP[k]);
  }
  for (const m of text.matchAll(/(^|[^A-Za-z$])(BTC|ETH|SOL|DOGE|XRP|BNB)([^A-Za-z]|$)/g)) found.add(m[2] + "-USD");
  return [...found];
}

function count(text, words) {
  const lower = text.toLowerCase();
  let n = 0;
  for (const w of words) {
    const isAscii = /^[\x00-\x7f]+$/.test(w);
    if (isAscii ? new RegExp(`(^|[^a-z])${w}([^a-z]|$)`).test(lower) : text.includes(w)) n++;
  }
  return n;
}

export async function extractWithRules(posts) {
  const calls = [];
  for (const post of posts) {
    const text = post.text || "";
    if (SKIP.some((re) => re.test(text))) continue;
    const symbols = findSymbols(text);
    if (symbols.length === 0 || symbols.length > 2) continue; // 一条帖子提一堆标的，规则判不准
    const bull = count(text, BULL);
    const bear = count(text, BEAR);
    if (bull === bear) continue;
    const direction = bull > bear ? "bull" : "bear";
    for (const symbol of symbols) calls.push({ postId: post.id, symbol, direction, conviction: "medium", note: "" });
  }
  return calls;
}
