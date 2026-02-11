/**
 * Vercel Serverless Function — 统一 API 代理
 * 将前端的 /api/feishu/* 和 /api/aihub-prod/* 请求代理到真实后端，绕过 CORS。
 */

const ROUTES = {
  'feishu':     'https://open.feishu.cn/open-apis/',
  'aihub-prod': 'https://ai-hub.xiaopeng.com/api/v1/beta/google/gemini/',
};

export const config = {
  api: { bodyParser: false },   // 保留原始 body（含 FormData）
  maxDuration: 60,              // 最长 60s（Hobby 计划上限）
};

/* 收集请求原始 body */
function collectBody(readable) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    readable.on('data', (c) => chunks.push(c));
    readable.on('end', () => resolve(Buffer.concat(chunks)));
    readable.on('error', reject);
  });
}

export default async function handler(req, res) {
  /* ---- CORS ---- */
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();

  /* ---- 解析路由 ---- */
  const reqUrl  = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
  const parts   = reqUrl.pathname.replace(/^\/api\//, '').split('/');
  const routeKey = parts[0];
  const targetBase = ROUTES[routeKey];

  if (!targetBase) {
    return res.status(404).json({ error: `Unknown proxy route: ${routeKey}` });
  }

  const restPath  = parts.slice(1).join('/');
  const targetUrl = targetBase + restPath + reqUrl.search;

  /* ---- 转发 body ---- */
  const rawBody = ['GET', 'HEAD'].includes(req.method)
    ? undefined
    : await collectBody(req);

  /* ---- 转发 headers（去掉逐跳头） ---- */
  const fwdHeaders = {};
  const skip = ['host', 'connection', 'transfer-encoding', 'content-length'];
  for (const [k, v] of Object.entries(req.headers)) {
    if (!skip.includes(k.toLowerCase())) fwdHeaders[k] = v;
  }

  /* ---- 请求上游 ---- */
  try {
    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers: fwdHeaders,
      body: rawBody,
    });

    const buf = Buffer.from(await upstream.arrayBuffer());
    const ct = upstream.headers.get('content-type');
    if (ct) res.setHeader('Content-Type', ct);

    return res.status(upstream.status).send(buf);
  } catch (err) {
    return res.status(502).json({ error: 'Proxy error: ' + err.message });
  }
}
