import "./src/env.js";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyze, capabilities, listReports, getReport } from "./src/analyze.js";

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const PORT = Number(process.env.PORT) || 4517;
const HOSTED = Boolean(process.env.HOSTED);
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

// —— 任务队列：一次分析要几分钟到十几分钟，不能让一个请求一直挂着（手机切后台就断了） ——
// 页面提交后拿到任务号，然后轮询进度；刷新页面或切回来都能接着看。
const MAX_RUNNING = Number(process.env.MAX_RUNNING) || 3;
const MAX_QUEUED = 20;
const JOB_TTL_MS = 2 * 3600 * 1000;
const jobs = new Map(); // id -> { status, stage, done, total, report, error, owner, createdAt, run }
const waiting = [];
let running = 0;

function pump() {
  while (running < MAX_RUNNING && waiting.length) {
    const job = waiting.shift();
    running++;
    job.status = "running";
    job.run((stage, params, done, total) => Object.assign(job, { stage, stageParams: params ?? {}, done: done ?? null, total: total ?? null }))
      .then((report) => Object.assign(job, { status: "done", report }))
      .catch((e) => Object.assign(job, { status: "error", error: e.message || "分析失败", code: e.code ?? null, params: e.params ?? {} }))
      .finally(() => {
        running--;
        job.run = null; // 丢掉闭包，里面有使用者的 key
        job.finishedAt = Date.now();
        pump();
      });
  }
}

setInterval(() => {
  for (const [id, j] of jobs) if (j.finishedAt && Date.now() - j.finishedAt > JOB_TTL_MS) jobs.delete(id);
}, 60000).unref();

function clientIp(req) {
  // 线上一般在反向代理后面，取代理加上的最后一个地址
  const xff = HOSTED ? String(req.headers["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(Boolean) : [];
  return xff[xff.length - 1] || req.socket.remoteAddress || "unknown";
}

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type, "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
  });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function readBody(req, limit = 5 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error("请求内容过大（上限 5MB）");
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** 只接受本站页面发来的提交，别的网站不能借访客的浏览器来触发分析。 */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname === "/api/config" && req.method === "GET") return send(res, 200, capabilities());

    if (url.pathname === "/api/analyze" && req.method === "POST") {
      if (!sameOrigin(req)) return send(res, 403, { error: "forbidden", code: "forbidden" });
      let body;
      try {
        body = JSON.parse((await readBody(req)) || "{}");
      } catch (e) {
        return send(res, 400, { error: "请求格式不对", code: "bad_request" });
      }
      const owner = clientIp(req);
      if ([...jobs.values()].some((j) => j.owner === owner && (j.status === "queued" || j.status === "running"))) {
        return send(res, 429, { error: "你已经有一个分析在进行中，等它跑完再提交下一个", code: "busy" });
      }
      if (waiting.length >= MAX_QUEUED) return send(res, 503, { error: "现在排队的人太多了，请过几分钟再试", code: "queue_full" });
      const id = crypto.randomBytes(12).toString("hex");
      const job = { status: "queued", stage: "queued", stageParams: {}, done: null, total: null, owner, createdAt: Date.now(), run: (onStage) => analyze(body, onStage) };
      jobs.set(id, job);
      waiting.push(job);
      pump();
      return send(res, 200, { jobId: id });
    }

    const jobMatch = url.pathname.match(/^\/api\/jobs\/([a-f0-9]{24})$/);
    if (jobMatch && req.method === "GET") {
      const j = jobs.get(jobMatch[1]);
      if (!j) return send(res, 404, { error: "任务不存在或已过期，请重新提交", code: "job_gone" });
      const ahead = j.status === "queued" ? waiting.indexOf(j) : 0;
      return send(res, 200, {
        status: j.status, stage: j.status === "queued" ? "queued" : j.stage,
        stageParams: j.status === "queued" ? { ahead } : j.stageParams,
        done: j.done, total: j.total, error: j.error, code: j.code, params: j.params, report: j.status === "done" ? j.report : undefined,
      });
    }

    if (url.pathname === "/api/reports" && req.method === "GET") return send(res, 200, await listReports());
    const repMatch = url.pathname.match(/^\/api\/reports\/([A-Za-z0-9_]{1,15})$/);
    if (repMatch && req.method === "GET") {
      const r = await getReport(repMatch[1]);
      return r ? send(res, 200, r) : send(res, 404, { error: "还没有这个博主的报告", code: "no_report" });
    }

    if (req.method !== "GET") return send(res, 405, { error: "method not allowed" });
    const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const file = path.join(PUBLIC, path.normalize(rel));
    if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, { error: "forbidden" });
    try {
      return send(res, 200, await fs.readFile(file), MIME[path.extname(file)] || "application/octet-stream");
    } catch {
      return send(res, 404, { error: "not found" });
    }
  } catch (e) {
    console.error("[server]", e.message);
    send(res, 500, { error: "服务器出错了", code: "server" });
  }
});

// 本机运行只监听 127.0.0.1；线上部署才对外开放
server.listen(PORT, HOSTED ? "0.0.0.0" : "127.0.0.1", () => console.log(`KOL Check 已启动：http://localhost:${PORT}${HOSTED ? "（线上模式）" : ""}`));
