// 手动导入：没有 X API 时，把帖子粘贴/上传进来。支持三种格式：
// 1) X 官方数据存档里的 tweets.js（window.YTD.tweets.part0 = [...]）
// 2) JSON 数组：[{ "id": "...", "created_at": "2024-01-02", "text": "..." }]
// 3) 纯文本，每行一条："2024-01-02 帖子内容"（日期后跟空格、逗号或 Tab）

function toIso(v) {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function parseImported(raw, handle = "imported") {
  const text = String(raw || "").trim();
  if (!text) throw new Error("导入内容为空");
  const posts = [];
  const push = (id, when, body, url, images) => {
    const createdAt = toIso(when);
    if (!createdAt || (!body && !images?.length)) return;
    posts.push({ id: String(id ?? posts.length + 1), createdAt, text: String(body ?? "").trim(), url: url || null, ...(images?.length ? { images } : {}) });
  };

  const jsonStart = text.search(/[\[{]/);
  const looksJson = text.startsWith("[") || text.startsWith("{") || /^window\.YTD\./.test(text);
  if (looksJson && jsonStart !== -1) {
    let data;
    try {
      data = JSON.parse(text.slice(jsonStart));
    } catch {
      throw new Error("JSON 解析失败，请检查格式");
    }
    for (const item of Array.isArray(data) ? data : [data]) {
      const t = item.tweet ?? item;
      const id = t.id_str ?? t.id;
      push(id, t.created_at ?? t.createdAt ?? t.date, t.full_text ?? t.text, id && /^\d+$/.test(String(id)) ? `https://x.com/${handle}/status/${id}` : t.url,
        // 只接受网络图片地址；不让粘贴进来的内容指向本机文件
        (t.images ?? t.extended_entities?.media?.map((m) => m.media_url_https) ?? []).filter((u) => /^https:\/\//i.test(String(u))));
    }
  } else {
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}(?:[T ]\d{1,2}:\d{2}(?::\d{2})?Z?)?)[\s,\t]+(.+)$/);
      if (!m) continue;
      // 补零并按 UTC 解析，否则 "2024/5/2" 会被当成本地时间，日期可能错开一天
      const [, y, mo, d, rest] = m[1].match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(.*)$/);
      const time = rest.trim().replace(/^T/, "").replace(/Z$/, "");
      push(null, `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}T${time ? time.padStart(5, "0") : "23:59"}Z`, m[2]);
    }
  }
  if (!posts.length) throw new Error("没有解析出任何带日期的帖子，请对照格式说明检查");
  posts.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { profile: { handle, name: handle }, posts };
}
