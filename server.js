/**
 * 名片扫描助手 - 本地代理服务
 * 功能：
 *   1. 托管静态文件（index.html）
 *   2. 代理转发飞书 API 和 AIHub API 请求，绕过浏览器 CORS 限制
 *
 * 启动: node server.js
 * 访问: http://localhost:3200
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 3200;

// MIME types
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

// Proxy target mapping
const PROXY_ROUTES = {
  '/api/feishu/': 'https://open.feishu.cn/open-apis/',
  '/api/aihub-prod/': 'https://ai-hub.xiaopeng.com/api/v1/beta/google/gemini/',
  '/api/aihub-pre/': 'https://ai-hub.deploy-test.xiaopeng.com/api/v1/beta/google/gemini/',
  '/api/aihub-test/': 'http://apisix-gw-ali-hd1.test.xiaopeng.com/xp-ai-hub-boot/api/v1/beta/google/gemini/',
};

function proxyRequest(clientReq, clientRes, targetUrl) {
  const parsed = new URL(targetUrl);
  const isHttps = parsed.protocol === 'https:';
  const transport = isHttps ? https : http;

  // Build headers: forward most, skip host/origin/referer
  const fwdHeaders = {};
  for (const [k, v] of Object.entries(clientReq.headers)) {
    const low = k.toLowerCase();
    if (['host', 'origin', 'referer', 'connection'].includes(low)) continue;
    fwdHeaders[k] = v;
  }
  fwdHeaders['host'] = parsed.host;

  const options = {
    hostname: parsed.hostname,
    port: parsed.port || (isHttps ? 443 : 80),
    path: parsed.pathname + parsed.search,
    method: clientReq.method,
    headers: fwdHeaders,
  };

  const proxyReq = transport.request(options, (proxyRes) => {
    // Add CORS headers to response
    clientRes.setHeader('Access-Control-Allow-Origin', '*');
    clientRes.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    clientRes.setHeader('Access-Control-Allow-Headers', '*');
    clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(clientRes);
  });

  proxyReq.on('error', (err) => {
    console.error('[proxy error]', err.message);
    clientRes.writeHead(502, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify({ error: 'Proxy error: ' + err.message }));
  });

  clientReq.pipe(proxyReq);
}

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

  // Check proxy routes
  for (const [prefix, target] of Object.entries(PROXY_ROUTES)) {
    if (pathname.startsWith(prefix)) {
      const rest = pathname.slice(prefix.length) + (parsedUrl.search || '');
      const targetUrl = target + rest;
      console.log(`[proxy] ${req.method} ${pathname} -> ${targetUrl}`);
      proxyRequest(req, res, targetUrl);
      return;
    }
  }

  // Static files
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
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log('='.repeat(50));
  console.log('  名片扫描助手 - 本地服务已启动');
  console.log(`  访问地址: http://localhost:${PORT}`);
  console.log('='.repeat(50));
});
