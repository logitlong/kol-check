// 第三方数据源 twitterapi.io（非 X 官方，价格约为官方的几十分之一）。
// 需要环境变量 TWITTERAPI_IO_KEY。接口：GET /twitter/user/last_tweets，每页最多 20 条，按返回条数计费。
const BASE = "https://api.twitterapi.io";
// 两次请求之间的间隔：先快速请求，一旦被限流（免费账号大约 5 秒才能请求一次）就自动降到慢速。
const FAST_MS = 400, SLOW_MS = 5500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function twitterApiIoAvailable() {
  return Boolean(process.env.TWITTERAPI_IO_KEY);
}

async function call(pathname, params, ctx) {
  const url = `${BASE}${pathname}?${new URLSearchParams(params)}`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { "X-API-Key": ctx.key }, signal: AbortSignal.timeout(30000) });
    if (res.status === 429 && attempt < 5) {
      ctx.delay = SLOW_MS;
      await sleep(6000 * (attempt + 1)); // 免费账号限速较严，退避久一点
      continue;
    }
    if (res.status === 401 || res.status === 403) throw new Error(`twitterapi.io 鉴权失败（${res.status}），请检查 twitterapi.io 的 key 是否填对`);
    if (res.status === 402) throw new Error("twitterapi.io 余额不足（402），请到其后台查看 credits");
    if (!res.ok) throw new Error(`twitterapi.io 返回 ${res.status}`);
    const json = await res.json();
    if (json.status === "error") throw new Error(`twitterapi.io：${json.msg || json.message || "未知错误"}`);
    return json;
  }
}

// 文档里没有写图片字段在哪，这里兼容几种常见位置；拿不到就当作没有图。
function photoUrls(t) {
  const media = t.extendedEntities?.media ?? t.extended_entities?.media ?? t.entities?.media ?? t.media ?? [];
  if (!Array.isArray(media)) return [];
  return media
    .filter((m) => (m.type ?? "photo") === "photo")
    .map((m) => m.media_url_https ?? m.media_url ?? m.url)
    .filter((u) => typeof u === "string" && /^https:\/\/pbs\.twimg\.com\//.test(u));
}

export async function fetchFromTwitterApiIo(handle, { key = process.env.TWITTERAPI_IO_KEY, maxPosts = Number(process.env.X_MAX_POSTS) || 3200, onProgress } = {}) {
  const ctx = { key, delay: FAST_MS };
  const info = await call("/twitter/user/info", { userName: handle }, ctx);
  if (info.data?.unavailable) throw new Error(`账号 @${handle} 不可用（${info.data.unavailableReason || "已冻结或不存在"}）`);
  const posts = [];
  const seen = new Set();
  let cursor = "";
  let emptyPages = 0;
  while (posts.length < maxPosts) {
    await sleep(ctx.delay);
    const page = await call("/twitter/user/last_tweets", { userName: handle, cursor, includeReplies: "false" }, ctx);
    const tweets = page.data?.tweets ?? page.tweets ?? [];
    let added = 0;
    for (const t of tweets) {
      if (!t?.id || seen.has(t.id) || t.retweeted_tweet) continue; // 跳过纯转推
      const d = new Date(t.createdAt);
      if (Number.isNaN(d.getTime())) continue;
      seen.add(t.id);
      added++;
      const images = photoUrls(t);
      posts.push({
        id: String(t.id), createdAt: d.toISOString(), text: t.text ?? "",
        url: t.url || `https://x.com/${handle}/status/${t.id}`,
        ...(t.quoted_tweet?.text ? { quoted: `@${t.quoted_tweet.author?.userName ?? "?"}: ${t.quoted_tweet.text}`.slice(0, 600) } : {}),
        ...(images.length ? { images } : {}),
      });
    }
    onProgress?.(posts.length, Math.min(maxPosts, info.data?.statusesCount || maxPosts));
    emptyPages = added ? 0 : emptyPages + 1;
    if (!page.has_next_page || !page.next_cursor || emptyPages >= 3) break;
    cursor = page.next_cursor;
  }
  posts.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return {
    profile: { handle, name: info.data?.name || handle, followers: info.data?.followers, totalPosts: info.data?.statusesCount },
    posts: posts.slice(-maxPosts),
  };
}
