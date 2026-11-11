// 回溯验证 + 评分。
// 口径：博主在 T 时刻发帖 → 以 T 之后第一个能成交的价格"进场"（没开盘就用下一次开盘价，盘中就用发帖后的盘中价），
// 这样既不会把发帖前已经发生的涨幅算给他，也不会错过他说的"今晚"。
// 然后按这条观点自己的期限持有，和同期大盘比较（超额收益）。进场当天算第 1 个交易日。
import { getDaily, firstIndexAfter, lastIndexAtOrBefore, priceAfter } from "./prices.js";
import { benchmarkFor } from "./symbols.js";

export const HORIZONS = [1, 5, 20, 60]; // 固定持有期，仅作参考
export const PRIMARY = "own"; // 评分口径：每条观点按它自己的期限对账
const DEFAULT_HORIZON = 20; // 提取器给不出期限时（关键词规则）的默认值
const DEDUPE_DAYS = 7; // 同一标的同一方向在其期限内（最多 7 天）反复喊，只算一次
const PRIOR = 20; // 样本少时把胜率往 50% 收缩的"虚拟样本数"

const dayDiff = (a, b) => (new Date(b) - new Date(a)) / 86400000;
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

async function loadAll(symbols) {
  const out = new Map();
  const queue = [...symbols];
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (queue.length) {
        const s = queue.shift();
        try {
          out.set(s, await getDaily(s));
        } catch {
          out.set(s, null);
        }
      }
    }),
  );
  return out;
}

/** 某标的在 [from,to] 期间任意一天买入、持有 h 个交易日的平均收益——"随便哪天买"的基线。 */
function driftBaseline(bars, h, from, to) {
  const rets = [];
  for (let i = Math.max(0, firstIndexAfter(bars, from) - 1); i + h < bars.length && bars[i].date <= to; i++) {
    rets.push(bars[i + h].close / bars[i].close - 1);
  }
  return mean(rets);
}

export async function evaluate(posts, rawCalls) {
  const postById = new Map(posts.map((p) => [String(p.id), p]));
  let calls = rawCalls
    .map((c) => ({ ...c, post: postById.get(String(c.postId)) }))
    .filter((c) => c.post)
    .map((c) => ({ ...c, date: c.post.createdAt.slice(0, 10), T: Math.floor(new Date(c.post.createdAt).getTime() / 1000) }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // "平仓"类帖子不是新观点：只用来结束之前同一标的的仓位。反向观点同样会结束之前的仓位。
  const closers = new Map();
  for (const c of calls) {
    const list = closers.get(c.symbol) ?? [];
    list.push({ T: c.T, type: c.kind === "exit" ? "exit" : c.direction });
    closers.set(c.symbol, list);
  }
  const exitCount = calls.filter((c) => c.kind === "exit").length;
  calls = calls.filter((c) => c.kind !== "exit").map((c) => ({ ...c, horizonDays: c.horizonDays || DEFAULT_HORIZON }));

  // 去重：防止"天天喊同一只票"把样本数刷高
  const lastKept = new Map();
  let duplicates = 0;
  calls = calls.filter((c) => {
    const key = c.symbol + "|" + c.direction;
    const prev = lastKept.get(key);
    if (prev && dayDiff(prev, c.date) < Math.min(DEDUPE_DAYS, c.horizonDays)) return duplicates++, false;
    lastKept.set(key, c.date);
    return true;
  });

  const symbols = new Set();
  for (const c of calls) {
    symbols.add(c.symbol);
    const b = benchmarkFor(c.symbol);
    if (b) symbols.add(b);
  }
  const data = await loadAll(symbols);

  // 没有外部基准的标的（BTC、指数），用"同期随机买入"的平均收益做基线
  const spans = new Map();
  for (const c of calls) {
    const s = spans.get(c.symbol) ?? { from: c.date, to: c.date };
    if (c.date > s.to) s.to = c.date;
    spans.set(c.symbol, s);
  }
  const driftCache = new Map();
  const drift = (symbol, h) => {
    const key = symbol + "|" + h;
    if (!driftCache.has(key)) {
      const span = spans.get(symbol);
      const from = new Date(new Date(span.from) - 365 * 86400000).toISOString().slice(0, 10);
      driftCache.set(key, driftBaseline(data.get(symbol).bars, h, from, span.to));
    }
    return driftCache.get(key);
  };

  const evaluated = [];
  for (const c of calls) {
    const base = {
      postId: c.postId, date: c.date, text: c.post.text, url: c.post.url ?? null,
      symbol: c.symbol, direction: c.direction, conviction: c.conviction, note: c.note || "", fromImage: Boolean(c.fromImage),
      horizonDays: c.horizonDays, horizonStated: Boolean(c.horizonStated),
    };
    const series = data.get(c.symbol);
    if (!series || series.bars.length < 2) { evaluated.push({ ...base, status: "no_data", outcomes: {} }); continue; }
    const bars = series.bars;
    const entry = await priceAfter(series, c.T);
    if (!entry) { evaluated.push({ ...base, name: series.name, status: "pending", outcomes: {} }); continue; }
    const i = entry.idx;
    if (dayDiff(c.date, bars[i].date) > 10) { evaluated.push({ ...base, name: series.name, status: "no_data", outcomes: {} }); continue; } // 当时还没上市/停牌
    const sign = c.direction === "bull" ? 1 : -1;
    const benchSymbol = benchmarkFor(c.symbol);
    const bseries = benchSymbol ? data.get(benchSymbol) : null;
    const bEntry = bseries ? await priceAfter(bseries, c.T) : null;
    // 进场当天算第 1 天；如果只能按当天收盘价进场，则从下一个交易日起算
    const exitIndex = (h) => (entry.mode === "close" ? i + h : i + h - 1);
    const calc = (exitPrice, j) => {
      const ret = exitPrice / entry.price - 1;
      const days = Math.max(1, j - i + (entry.mode === "close" ? 0 : 1));
      let bench = null;
      if (bseries) {
        const b1 = lastIndexAtOrBefore(bseries.bars, bars[j].date);
        if (bEntry && b1 >= bEntry.idx) bench = bseries.bars[b1].close / bEntry.price - 1;
      } else {
        bench = drift(c.symbol, days);
      }
      const adj = sign * ret;
      const excess = bench == null ? null : sign * (ret - bench);
      return { exitDate: bars[j].date, days, ret, adj, bench, excess, win: (excess ?? adj) > 0 };
    };
    const outcomes = {};
    for (const h of HORIZONS) {
      const j = exitIndex(h);
      if (j < bars.length) outcomes[h] = calc(bars[j].close, j);
    }

    // 博主口径：持有到他自己说的期限；期限内他喊了平仓或反向，就按那条帖子之后第一个能成交的价格结束
    const j = exitIndex(c.horizonDays);
    let own = j < bars.length ? { ...calc(bars[j].close, j), exitReason: "expiry" } : null;
    const closer = (closers.get(c.symbol) ?? []).find((e) => e.T > c.T && (e.type === "exit" || e.type !== c.direction));
    if (closer) {
      const x = await priceAfter(series, closer.T);
      if (x && (x.idx < j || (x.idx === j && x.mode !== "close"))) {
        own = { ...calc(x.price, x.idx), exitReason: closer.type === "exit" ? "exit" : "reversal" };
      }
    }
    if (own) outcomes.own = own;
    evaluated.push({
      ...base, name: series.name, currency: series.currency,
      entryDate: bars[i].date, entryPrice: entry.price, entryMode: entry.mode,
      benchmark: benchSymbol ?? "drift",
      status: Object.keys(outcomes).length ? "done" : "pending",
      outcomes,
    });
  }

  const horizons = {};
  for (const h of [PRIMARY, ...HORIZONS]) {
    const os = evaluated.map((c) => c.outcomes[h]).filter(Boolean);
    const ex = os.map((o) => o.excess).filter((x) => x != null);
    horizons[h] = {
      n: os.length,
      hitRate: os.length ? os.filter((o) => o.adj > 0).length / os.length : null,
      winRate: os.length ? os.filter((o) => o.win).length / os.length : null,
      avgReturn: mean(os.map((o) => o.adj)),
      medianReturn: median(os.map((o) => o.adj)),
      avgExcess: mean(ex),
    };
  }

  const bySymbolMap = new Map();
  for (const c of evaluated) {
    const g = bySymbolMap.get(c.symbol) ?? { symbol: c.symbol, name: c.name ?? c.symbol, calls: 0, bull: 0, bear: 0, os: [] };
    g.calls++;
    g[c.direction]++;
    if (c.outcomes[PRIMARY]) g.os.push(c.outcomes[PRIMARY]);
    bySymbolMap.set(c.symbol, g);
  }
  const bySymbol = [...bySymbolMap.values()]
    .map(({ os, ...g }) => ({ ...g, evaluated: os.length, winRate: os.length ? os.filter((o) => o.win).length / os.length : null, avgReturn: mean(os.map((o) => o.adj)) }))
    .sort((a, b) => b.calls - a.calls);

  return { calls: evaluated, horizons, bySymbol, duplicates, exitCount };
}

// —— 危险信号：和预测准不准无关，但和"是不是在割韭菜"强相关 ——
const RED_FLAGS = [
  { id: "funnel", label: "引流到私域/付费群", re: /(加群|进群|入群|私信我|付费群|会员群|vip\s*群|带单|跟单|喊单|t\.me\/|telegram|discord\.gg|whatsapp|加微信|加v|dm me|join my (group|channel|vip))/i },
  { id: "guarantee", label: "承诺收益/夸张回报", re: /(稳赚|包赚|保本|无风险|必涨|闭眼买|财富自由|百倍|千倍|翻\s*\d+\s*倍|guaranteed|risk[- ]free|100x|1000x|easy money|can'?t lose|絶対儲かる|爆益確定)/i },
  { id: "referral", label: "返佣/邀请链接", re: /(邀请码|返佣|手续费减免|注册链接|referral|ref=|invite code|sign ?up (with|using) my)/i },
];

export function detectRedFlags(posts) {
  const flags = RED_FLAGS.map((f) => ({ id: f.id, count: 0, examples: [] }));
  let flagged = 0;
  for (const p of posts) {
    let any = false;
    RED_FLAGS.forEach((f, i) => {
      if (!f.re.test(p.text)) return;
      any = true;
      flags[i].count++;
      if (flags[i].examples.length < 3) flags[i].examples.push({ date: p.createdAt.slice(0, 10), text: p.text.slice(0, 160) });
    });
    if (any) flagged++;
  }
  return { flaggedPosts: flagged, ratio: posts.length ? flagged / posts.length : 0, flags: flags.filter((f) => f.count) };
}

export function computeScore(horizons, redFlags) {
  // 只返回分数和等级代号，文字由页面按访客的语言显示
  const h = horizons[PRIMARY];
  const n = h?.n ?? 0;
  if (n < 5) return { score: null, gradeKey: "insufficient", n, parts: null };
  const wins = Math.round(h.winRate * n);
  const shrunkWin = (wins + PRIOR / 2) / (n + PRIOR);
  const edge = h.avgExcess ?? h.avgReturn ?? 0;
  const shrunkEdge = edge * (n / (n + PRIOR));
  const winPart = (shrunkWin - 0.5) * 200;
  const edgePart = Math.max(-15, Math.min(15, shrunkEdge * 200));
  const penalty = Math.min(20, Math.round(redFlags.ratio * 200));
  const score = Math.round(Math.max(0, Math.min(100, 50 + winPart + edgePart - penalty)));
  const gradeKey = score >= 70 ? "reliable" : score >= 57 ? "slight" : score >= 45 ? "coin" : score >= 30 ? "unreliable" : "contrarian";
  return { score, gradeKey, n, parts: { shrunkWin, winPart, edgePart, penalty, n } };
}
