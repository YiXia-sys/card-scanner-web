/**
 * 名片扫描助手 - 代理服务
 * 功能：
 *   1. 托管静态文件（index.html）
 *   2. 代理转发飞书 API 和 AIHub API 请求，绕过浏览器 CORS 限制
 *   3. 服务端注入密钥，前端代码零泄露
 *
 * 启动: node server.js
 * 访问: http://localhost:3200
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

// ========== 读取 .env 配置 ==========
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    line = line.trim();
    if (!line || line.startsWith('#')) return;
    const idx = line.indexOf('=');
    if (idx > 0) {
      const key = line.slice(0, idx).trim();
      const val = line.slice(idx + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  });
}

const PORT = process.env.PORT || 3200;
const FEISHU_APP_ID = process.env.FEISHU_APP_ID || '';
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const DOUBAO_API_KEY = process.env.DOUBAO_API_KEY || '';

// Timestamped logging
function ts() {
  return new Date().toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
}
function log(...args) { console.log(`[${ts()}]`, ...args); }
function logErr(...args) { console.error(`[${ts()}]`, ...args); }

// ========== MIME & 路由 ==========
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

const PROXY_ROUTES = {
  '/api/feishu/': 'https://open.feishu.cn/open-apis/',
  // 豆包 (Doubao) - OpenAI 兼容格式
  '/api/doubao-prod/': 'https://ai-hub.xiaopeng.com/api/v1/',
  '/api/doubao-pre/': 'https://ai-hub.deploy-test.xiaopeng.com/api/v1/',
  '/api/doubao-test/': 'http://apisix-gw-ali-hd1.test.xiaopeng.com/xp-ai-hub-boot/api/v1/',
  // Gemini (保留，暂不使用)
  '/api/aihub-prod/': 'https://ai-hub.xiaopeng.com/api/v1/beta/google/gemini/',
  '/api/aihub-pre/': 'https://ai-hub.deploy-test.xiaopeng.com/api/v1/beta/google/gemini/',
  '/api/aihub-test/': 'http://apisix-gw-ali-hd1.test.xiaopeng.com/xp-ai-hub-boot/api/v1/beta/google/gemini/',
};

// ========== 代理请求（全量缓冲，避免 pipe 断裂） ==========
function proxyRequest(clientReq, clientRes, targetUrl, extraHeaders) {
  const startTime = Date.now();

  // CORS response headers (guaranteed on every response)
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': '*',
  };

  // 1. Buffer full client request body first
  const reqChunks = [];
  clientReq.on('data', c => reqChunks.push(c));
  clientReq.on('end', () => {
    const reqBody = Buffer.concat(reqChunks);

    const parsed = new URL(targetUrl);
    const isHttps = parsed.protocol === 'https:';
    const transport = isHttps ? https : http;

    // Build forwarding headers
    const fwdHeaders = {};
    for (const [k, v] of Object.entries(clientReq.headers)) {
      const low = k.toLowerCase();
      // 去掉 accept-encoding：防止上游返回 gzip/br 压缩数据，proxy 无法正确转发给浏览器
      if (['host', 'origin', 'referer', 'connection', 'transfer-encoding', 'accept-encoding'].includes(low)) continue;
      fwdHeaders[k] = v;
    }
    fwdHeaders['host'] = parsed.host;
    fwdHeaders['content-length'] = reqBody.length;
    if (extraHeaders) Object.assign(fwdHeaders, extraHeaders);

    // 2. Send to upstream
    const proxyReq = transport.request({
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: clientReq.method,
      headers: fwdHeaders,
    }, (proxyRes) => {
      // 3. Buffer full upstream response
      const resChunks = [];
      proxyRes.on('data', c => resChunks.push(c));
      proxyRes.on('end', () => {
        const resBody = Buffer.concat(resChunks);
        const elapsed = Date.now() - startTime;
        const status = proxyRes.statusCode;

        const encoding = proxyRes.headers['content-encoding'] || 'none';
        if (status >= 400) {
          logErr(`[resp] ${status} ${elapsed}ms enc=${encoding} ${targetUrl}`);
          logErr(`[resp body] ${resBody.toString('utf8').slice(0, 1000)}`);
        } else {
          // 飞书请求也打印 body 前 300 字，方便排查"返回 200 但内容异常"的问题
          const isFeishu = targetUrl.includes('feishu.cn');
          const bodyPreview = isFeishu ? ` | body: ${resBody.toString('utf8').slice(0, 300)}` : '';
          log(`[resp] ${status} ${elapsed}ms enc=${encoding} ${targetUrl}${bodyPreview}`);
        }

        // 4. Return to browser with clean headers
        const h = { ...corsHeaders };
        // 转发关键响应头（Content-Type, Content-Encoding, Content-Disposition 等）
        const forwardHeaders = ['content-type', 'content-encoding', 'content-disposition'];
        for (const fh of forwardHeaders) {
          if (proxyRes.headers[fh]) h[fh] = proxyRes.headers[fh];
        }
        h['Content-Length'] = resBody.length;
        clientRes.writeHead(status, h);
        clientRes.end(resBody);
      });
    });

    proxyReq.on('error', (err) => {
      const elapsed = Date.now() - startTime;
      logErr(`[proxy error] ${elapsed}ms ${err.message} -> ${targetUrl}`);
      const body = JSON.stringify({ error: 'Proxy error: ' + err.message });
      clientRes.writeHead(502, { ...corsHeaders, 'Content-Type': 'application/json' });
      clientRes.end(body);
    });

    // Send buffered body all at once (no pipe race condition)
    proxyReq.end(reqBody);
  });
}

// ========== 服务端获取 tenant_access_token ==========
function handleTenantToken(req, res) {
  if (!FEISHU_APP_ID || !FEISHU_APP_SECRET) {
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ code: -1, msg: '服务端未配置 FEISHU_APP_ID / FEISHU_APP_SECRET' }));
    return;
  }

  const body = JSON.stringify({ app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET });
  const startTime = Date.now();

  const proxyReq = https.request({
    hostname: 'open.feishu.cn',
    path: '/open-apis/auth/v3/tenant_access_token/internal',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
    },
  }, (proxyRes) => {
    const chunks = [];
    proxyRes.on('data', c => chunks.push(c));
    proxyRes.on('end', () => {
      const elapsed = Date.now() - startTime;
      const respBody = Buffer.concat(chunks).toString('utf8');
      const status = proxyRes.statusCode;
      log(`[tenant-token] ${status} ${elapsed}ms`);
      if (status >= 400) logErr(`[tenant-token body] ${respBody.slice(0, 500)}`);
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.writeHead(status);
      res.end(respBody);
    });
  });

  proxyReq.on('error', (err) => {
    const elapsed = Date.now() - startTime;
    logErr(`[tenant-token error] ${elapsed}ms ${err.message}`);
    res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ code: -1, msg: 'Proxy error: ' + err.message }));
  });

  proxyReq.write(body);
  proxyReq.end();
}

// ========== HTTP 服务 ==========
const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url);
  const pathname = parsedUrl.pathname;

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Max-Age': '86400',
    });
    res.end();
    return;
  }

  // --- 服务端获取 tenant token（密钥不经过前端） ---
  if (pathname === '/api/internal/tenant-token' && req.method === 'POST') {
    log('[internal] tenant-token request');
    handleTenantToken(req, res);
    return;
  }

  // --- 代理路由 ---
  for (const [prefix, target] of Object.entries(PROXY_ROUTES)) {
    if (pathname.startsWith(prefix)) {
      const rest = pathname.slice(prefix.length) + (parsedUrl.search || '');
      const targetUrl = target + rest;
      log(`[proxy] ${req.method} ${pathname} -> ${targetUrl}`);

      // 对 AIHub / Doubao 路由自动注入 API-KEY（前端不传）
      let extraHeaders = null;
      if (prefix.startsWith('/api/doubao') && DOUBAO_API_KEY) {
        extraHeaders = { 'API-KEY': DOUBAO_API_KEY };
      } else if (prefix.startsWith('/api/aihub') && GEMINI_API_KEY) {
        extraHeaders = { 'API-KEY': GEMINI_API_KEY };
      }

      proxyRequest(req, res, targetUrl, extraHeaders);
      return;
    }
  }

  // --- 静态文件 ---
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.join(__dirname, filePath);

  const ext = path.extname(filePath);
  const contentType = MIME[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }
    // Prevent mobile browser caching stale HTML/JS
    const headers = { 'Content-Type': contentType };
    if (ext === '.html' || ext === '.js') {
      headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
      headers['Pragma'] = 'no-cache';
      headers['Expires'] = '0';
    }
    res.writeHead(200, headers);
    res.end(data);
  });
});

server.listen(PORT, () => {
  log('='.repeat(50));
  log('  名片扫描助手 - 服务已启动');
  log(`  访问地址: http://localhost:${PORT}`);
  log('  密钥状态:');
  log(`    FEISHU_APP_ID:     ${FEISHU_APP_ID ? '✓ 已配置' : '✗ 未配置'}`);
  log(`    FEISHU_APP_SECRET: ${FEISHU_APP_SECRET ? '✓ 已配置' : '✗ 未配置'}`);
  log(`    DOUBAO_API_KEY:    ${DOUBAO_API_KEY ? '✓ 已配置' : '✗ 未配置'}`);
  log(`    GEMINI_API_KEY:    ${GEMINI_API_KEY ? '✓ 已配置' : '✗ 未配置 (Gemini备用)'}`);
  log('='.repeat(50));
});
