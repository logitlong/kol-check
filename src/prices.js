// 日线行情：Yahoo Finance chart 接口（免费，无需 key），本地缓存 12 小时。
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CACHE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "prices");
const TTL_MS = 12 * 3600 * 1000;
const mem = new Map();

function cacheFile(symbol) {
  return path.join(CACHE_DIR, symbol.replace(/[^A-Za-z0-9.\-]/g, "_") + ".json");
}

async function fetchYahoo(symbol) {
  const now = Math.floor(Date.now() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=0&period2=${now}&interval=1d`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(20000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`行情接口返回 ${res.status}（${symbol}）`);
  const json = await res.json();
  const r = json?.chart?.result?.[0];
  if (!r?.timestamp) return null;
  const offset = r.meta?.gmtoffset ?? 0;
  const q = r.indicators?.quote?.[0] ?? {};
  const adj = r.indicators?.adjclose?.[0]?.adjclose;
  const bars = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    const raw = q.close?.[i];
    const c = adj?.[i] ?? raw;
    if (c == null || !(c > 0)) continue;
    const f = raw > 0 ? c / raw : 1; // 复权系数：开盘价、盘中价都要乘它，才能和复权收盘价比较
    const open = q.open?.[i] > 0 ? q.open[i] * f : c;
    // 用交易所本地日期，避免时区把交易日错开一天
    const date = new Date((r.timestamp[i] + offset) * 1000).toISOString().slice(0, 10);
    if (bars.length && bars[bars.length - 1].date === date) bars[bars.length - 1].close = c;
    else bars.push({ date, t: r.timestamp[i], open, close: c, f });
  }
  // 一个交易时段多长（秒）：美股 6.5 小时，加密货币 24 小时
  const reg = r.meta?.currentTradingPeriod?.regular;
  let sessionLen = reg?.end > reg?.start ? reg.end - reg.start : 6.5 * 3600;
  if (r.meta?.instrumentType === "CRYPTOCURRENCY") sessionLen = 86400;
  return { symbol, name: r.meta?.longName || r.meta?.shortName || symbol, currency: r.meta?.currency, sessionLen, bars };
}

/** 返回 {symbol,name,currency,bars:[{date,close}]}，找不到该代码时返回 null。 */
export async function getDaily(symbol) {
  if (mem.has(symbol)) return mem.get(symbol);
  const p = (async () => {
    const file = cacheFile(symbol);
    try {
      const cached = JSON.parse(await fs.readFile(file, "utf8"));
      if (cached.v === 2 && Date.now() - cached.fetchedAt < TTL_MS) return cached.data;
    } catch {}
    const data = await fetchYahoo(symbol);
    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.writeFile(file, JSON.stringify({ v: 2, fetchedAt: Date.now(), data }));
    return data;
  })();
  mem.set(symbol, p);
  try {
    return await p;
  } catch (e) {
    mem.delete(symbol);
    throw e;
  }
}

const hourlyMem = new Map();
/** 最近约两年的小时线 [{t, open}]（未复权），用来取"发帖那一刻"的盘中价。拿不到返回 null。 */
export function getHourly(symbol) {
  if (!hourlyMem.has(symbol)) {
    hourlyMem.set(symbol, (async () => {
      const file = cacheFile(symbol + ".1h");
      try {
        const cached = JSON.parse(await fs.readFile(file, "utf8"));
        if (Date.now() - cached.fetchedAt < TTL_MS) return cached.data;
      } catch {}
      try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=730d&interval=1h`;
        const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(20000) });
        if (!res.ok) return null;
        const r = (await res.json())?.chart?.result?.[0];
        const o = r?.indicators?.quote?.[0]?.open;
        if (!r?.timestamp || !o) return null;
        const data = [];
        for (let i = 0; i < r.timestamp.length; i++) if (o[i] > 0) data.push({ t: r.timestamp[i], open: o[i] });
        await fs.mkdir(CACHE_DIR, { recursive: true });
        await fs.writeFile(file, JSON.stringify({ fetchedAt: Date.now(), data }));
        return data;
      } catch {
        return null;
      }
    })());
  }
  return hourlyMem.get(symbol);
}

const HOURLY_WINDOW = 720 * 86400; // 小时线只有最近约两年
/**
 * 发帖时刻 T（秒）之后第一个能成交的价格：
 * - 发帖时没开盘 → 下一个交易时段的开盘价（mode "open"）
 * - 盘中发帖 → 发帖后第一根小时线的开盘价（"intraday"）；太久以前没有小时线，或已是最后一小时 → 当天收盘价（"close"）
 */
export async function priceAfter(series, T) {
  const { bars, sessionLen } = series;
  let lo = 0, hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].t + sessionLen > T) hi = mid;
    else lo = mid + 1;
  }
  if (lo >= bars.length) return null;
  const b = bars[lo];
  if (T <= b.t) return { idx: lo, price: b.open, mode: "open" };
  if (Date.now() / 1000 - T < HOURLY_WINDOW) {
    const hourly = await getHourly(series.symbol);
    const h = hourly?.find((x) => x.t >= T && x.t < b.t + sessionLen);
    if (h) return { idx: lo, price: h.open * b.f, mode: "intraday" };
  }
  return { idx: lo, price: b.close, mode: "close" };
}

/** 第一个 date 严格大于 d 的下标（发帖后的下一个交易日），没有则 -1。 */
export function firstIndexAfter(bars, d) {
  let lo = 0, hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].date > d) hi = mid;
    else lo = mid + 1;
  }
  return lo < bars.length ? lo : -1;
}

/** 最后一个 date <= d 的下标，没有则 -1。 */
export function lastIndexAtOrBefore(bars, d) {
  const i = firstIndexAfter(bars, d);
  return i === -1 ? bars.length - 1 : i - 1;
}
