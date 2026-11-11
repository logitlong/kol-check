// X 官方 API v2 数据源。需要环境变量 X_BEARER_TOKEN（developer.x.com 申请，按量付费）。
// 注意：用户时间线接口最多只能回溯最近约 3200 条帖子，这是 X 的限制。
const BASE = "https://api.x.com/2";

export function xApiAvailable() {
  return Boolean(process.env.X_BEARER_TOKEN);
}

async function call(pathAndQuery) {
  const res = await fetch(BASE + pathAndQuery, {
    headers: { Authorization: `Bearer ${process.env.X_BEARER_TOKEN}` },
    signal: AbortSignal.timeout(30000),
  });
  if (res.status === 402) throw new Error("X API 账户余额为 0（402 credits depleted），请到 developer.x.com 后台充值 credits 后再试");
  if (res.status === 429) throw new Error("X API 触发限流（429），请稍后再试");
  if (res.status === 401 || res.status === 403) throw new Error(`X API 鉴权失败（${res.status}），请检查 X_BEARER_TOKEN 和套餐权限`);
  if (!res.ok) throw new Error(`X API 返回 ${res.status}`);
  return res.json();
}

export async function fetchFromX(handle, { maxPosts = Number(process.env.X_MAX_POSTS) || 3200, onProgress } = {}) {
  const user = await call(`/users/by/username/${encodeURIComponent(handle)}?user.fields=name,public_metrics,created_at`);
  if (!user.data) throw new Error(`找不到账号 @${handle}`);
  const posts = [];
  let token;
  do {
    const q = new URLSearchParams({
      max_results: "100", "tweet.fields": "created_at,attachments", exclude: "retweets",
      expansions: "attachments.media_keys", "media.fields": "type,url",
    });
    if (token) q.set("pagination_token", token);
    const page = await call(`/users/${user.data.id}/tweets?${q}`);
    const media = new Map((page.includes?.media ?? []).map((m) => [m.media_key, m]));
    for (const t of page.data ?? []) {
      const images = (t.attachments?.media_keys ?? []).map((k) => media.get(k)).filter((m) => m?.type === "photo" && m.url).map((m) => m.url);
      posts.push({ id: t.id, createdAt: t.created_at, text: t.text, url: `https://x.com/${handle}/status/${t.id}`, ...(images.length ? { images } : {}) });
    }
    token = page.meta?.next_token;
    onProgress?.(posts.length);
  } while (token && posts.length < maxPosts);
  return { profile: { handle, name: user.data.name, followers: user.data.public_metrics?.followers_count }, posts };
}
