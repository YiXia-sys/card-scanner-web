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
const APP_ENV = process.env.APP_ENV || 'production';
const FEISHU_APP_ID = process.env.FEISHU_APP_ID || '';
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const DOUBAO_API_KEY = process.env.DOUBAO_API_KEY || '';

const IMAGE_MAX_AGE_DAYS = parseInt(process.env.IMAGE_MAX_AGE_DAYS || '30', 10);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

// Timestamped logging
function ts() {
  return new Date().toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
}
function log(...args) { console.log(`[${ts()}]`, ...args); }
function logErr(...args) { console.error(`[${ts()}]`, ...args); }

// ========== JSON 文件存储层 ==========
function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }

function readJSON(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return typeof fallback === 'function' ? fallback() : fallback; }
}

function writeJSON(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// --- Sessions ---
const sessionsPath = () => path.join(DATA_DIR, 'sessions.json');

function getSession(token) {
  const sessions = readJSON(sessionsPath(), {});
  const s = sessions[token];
  if (!s) return null;
  if (s.expireAt && Date.now() / 1000 > s.expireAt) {
    delete sessions[token];
    writeJSON(sessionsPath(), sessions);
    return null;
  }
  return s;
}

function saveSession(token, userId, userName, expiresIn) {
  const sessions = readJSON(sessionsPath(), {});
  sessions[token] = {
    userId,
    userName,
    expireAt: Math.floor(Date.now() / 1000) + (expiresIn || 7200),
  };
  writeJSON(sessionsPath(), sessions);
}

// --- Tasks per user ---
const userTasksPath = (userId) => path.join(DATA_DIR, 'users', userId, 'tasks.json');

function getUserTasks(userId) {
  return readJSON(userTasksPath(userId), []);
}

function saveUserTasks(userId, tasks) {
  writeJSON(userTasksPath(userId), tasks);
}

// --- Images per user ---
function userImagesDir(userId) {
  const dir = path.join(DATA_DIR, 'users', userId, 'images');
  ensureDir(dir);
  return dir;
}

function imageFilePath(userId, taskId, suffix) {
  const safe = String(taskId).replace(/[^a-zA-Z0-9._-]/g, '_');
  const safeSuffix = String(suffix).replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(userImagesDir(userId), `${safe}_${safeSuffix}.jpg`);
}

// ========== 鉴权中间件 ==========
function authenticate(req) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return null;
  return getSession(token);
}

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

// ========== 任务 CRUD API ==========
async function handleGetTasks(req, res, user) {
  const tasks = getUserTasks(user.userId);
  sendJSON(res, 200, tasks);
}

async function handleCreateTasks(req, res, user) {
  const body = JSON.parse((await readBody(req)).toString('utf8'));
  const newTasks = Array.isArray(body) ? body : [body];
  const tasks = getUserTasks(user.userId);
  for (const t of newTasks) {
    t.userId = user.userId;
    tasks.unshift(t);
  }
  saveUserTasks(user.userId, tasks);
  sendJSON(res, 201, { ok: true, count: newTasks.length });
}

async function handleUpdateTask(req, res, user, taskId) {
  const updates = JSON.parse((await readBody(req)).toString('utf8'));
  const tasks = getUserTasks(user.userId);
  const task = tasks.find(t => String(t.id) === taskId);
  if (!task) return sendJSON(res, 404, { error: 'Task not found' });
  Object.assign(task, updates, { updatedAt: new Date().toLocaleString() });
  saveUserTasks(user.userId, tasks);
  sendJSON(res, 200, task);
}

async function handleReplaceTasks(req, res, user) {
  const body = JSON.parse((await readBody(req)).toString('utf8'));
  if (!Array.isArray(body)) return sendJSON(res, 400, { error: 'Expected array' });
  saveUserTasks(user.userId, body);
  sendJSON(res, 200, { ok: true, count: body.length });
}

async function handleDeleteTasks(req, res, user) {
  const body = JSON.parse((await readBody(req)).toString('utf8'));
  const tasks = getUserTasks(user.userId);
  let toRemove;
  if (body.ids && Array.isArray(body.ids)) {
    const idSet = new Set(body.ids.map(String));
    toRemove = tasks.filter(t => idSet.has(String(t.id)));
  } else if (body.status) {
    toRemove = body.status === 'all' ? [...tasks] : tasks.filter(t => t.status === body.status);
  } else {
    return sendJSON(res, 400, { error: 'Provide ids or status' });
  }
  // Clean up images for removed tasks
  for (const t of toRemove) {
    cleanTaskImages(user.userId, t);
  }
  const remaining = tasks.filter(t => !toRemove.includes(t));
  saveUserTasks(user.userId, remaining);
  sendJSON(res, 200, { ok: true, removed: toRemove.length });
}

function cleanTaskImages(userId, task) {
  const dir = path.join(DATA_DIR, 'users', userId, 'images');
  if (!fs.existsSync(dir)) return;
  const prefix = String(task.id).replace(/[^a-zA-Z0-9._-]/g, '_') + '_';
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith(prefix)) {
        fs.unlinkSync(path.join(dir, f));
      }
    }
  } catch (e) { logErr('[cleanTaskImages]', e.message); }
}

// ========== 图片 API ==========
async function handleUploadImage(req, res, user, taskId, suffix) {
  // 磁盘空间检查
  try {
    const stat = fs.statfsSync(DATA_DIR);
    const freeGB = (stat.bfree * stat.bsize) / (1024 ** 3);
    if (freeGB < 2) return sendJSON(res, 507, { error: `磁盘空间不足 (${freeGB.toFixed(1)}GB)，请清理后重试` });
  } catch {}

  const body = JSON.parse((await readBody(req)).toString('utf8'));
  const dataUrl = body.data;
  if (!dataUrl) return sendJSON(res, 400, { error: 'Missing data field' });

  const filePath = imageFilePath(user.userId, taskId, suffix);
  // dataUrl format: data:image/jpeg;base64,xxxxx
  const base64Data = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
  fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));
  log(`[image] saved ${filePath} (${(fs.statSync(filePath).size / 1024).toFixed(0)}KB)`);
  sendJSON(res, 201, { ok: true });
}

async function handleGetImage(req, res, user, taskId, suffix) {
  const filePath = imageFilePath(user.userId, taskId, suffix);
  if (!fs.existsSync(filePath)) return sendJSON(res, 404, { error: 'Image not found' });
  const buf = fs.readFileSync(filePath);
  const dataUrl = 'data:image/jpeg;base64,' + buf.toString('base64');
  sendJSON(res, 200, { data: dataUrl });
}

async function handleDeleteImage(req, res, user, taskId, suffix) {
  const filePath = imageFilePath(user.userId, taskId, suffix);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  sendJSON(res, 200, { ok: true });
}

// ========== 启动时清理超龄图片 ==========
function cleanExpiredImages() {
  const usersDir = path.join(DATA_DIR, 'users');
  if (!fs.existsSync(usersDir)) return;
  const maxAge = IMAGE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const now = Date.now();
  let cleaned = 0;
  for (const uid of fs.readdirSync(usersDir)) {
    const imgDir = path.join(usersDir, uid, 'images');
    if (!fs.existsSync(imgDir)) continue;
    for (const f of fs.readdirSync(imgDir)) {
      const fp = path.join(imgDir, f);
      try {
        if (now - fs.statSync(fp).mtimeMs > maxAge) { fs.unlinkSync(fp); cleaned++; }
      } catch {}
    }
  }
  if (cleaned) log(`[cleanup] 已清理 ${cleaned} 张超过 ${IMAGE_MAX_AGE_DAYS} 天的图片`);
}

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

// ========== OAuth token 交换（支持 authorization_code 和 refresh_token）==========
// 交换成功后自动获取用户信息并写入 session
function handleOAuthToken(req, res) {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = {}; }

    const tokenBody = {
      grant_type: body.grant_type || 'authorization_code',
      client_id: FEISHU_APP_ID,
      client_secret: FEISHU_APP_SECRET,
    };

    if (body.grant_type === 'refresh_token') {
      tokenBody.refresh_token = body.refresh_token;
    } else {
      tokenBody.code = body.code;
      if (body.redirect_uri) tokenBody.redirect_uri = body.redirect_uri;
    }

    const postBody = JSON.stringify(tokenBody);
    const startTime = Date.now();

    const proxyReq = https.request({
      hostname: 'open.feishu.cn',
      path: '/open-apis/authen/v2/oauth/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(postBody),
      },
    }, (proxyRes) => {
      const resChunks = [];
      proxyRes.on('data', c => resChunks.push(c));
      proxyRes.on('end', () => {
        const elapsed = Date.now() - startTime;
        const respBody = Buffer.concat(resChunks).toString('utf8');
        const status = proxyRes.statusCode;
        log(`[oauth-token] ${status} ${elapsed}ms grant=${tokenBody.grant_type}`);
        if (status >= 400) logErr(`[oauth-token body] ${respBody.slice(0, 500)}`);

        // 交换成功后，获取用户信息并写入 session
        let tokenData;
        try { tokenData = JSON.parse(respBody); } catch { tokenData = {}; }
        if (tokenData.access_token) {
          fetchUserInfoAndSaveSession(tokenData.access_token, tokenData.expires_in || 7200);
        }

        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.writeHead(status);
        res.end(respBody);
      });
    });

    proxyReq.on('error', (err) => {
      logErr(`[oauth-token error] ${err.message}`);
      res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ code: -1, msg: 'Proxy error: ' + err.message }));
    });

    proxyReq.write(postBody);
    proxyReq.end();
  });
}

// 用 access_token 调用飞书 user_info API，获取 user_id 和 name，写入 session
function fetchUserInfoAndSaveSession(accessToken, expiresIn) {
  const infoReq = https.request({
    hostname: 'open.feishu.cn',
    path: '/open-apis/authen/v1/user_info',
    method: 'GET',
    headers: { 'Authorization': 'Bearer ' + accessToken },
  }, (infoRes) => {
    const chunks = [];
    infoRes.on('data', c => chunks.push(c));
    infoRes.on('end', () => {
      try {
        const info = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (info.code === 0 && info.data) {
          const userId = info.data.user_id || info.data.open_id || 'unknown';
          const userName = info.data.name || '';
          saveSession(accessToken, userId, userName, expiresIn);
          log(`[session] saved user=${userName}(${userId}) expires_in=${expiresIn}s`);
        } else {
          logErr(`[session] user_info failed: ${JSON.stringify(info).slice(0, 300)}`);
        }
      } catch (e) { logErr(`[session] parse error: ${e.message}`); }
    });
  });
  infoReq.on('error', (err) => logErr(`[session] user_info request error: ${err.message}`));
  infoReq.end();
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

  // --- 应用配置（APP_ID + 环境标识） ---
  if (pathname === '/api/internal/oauth-config' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ app_id: FEISHU_APP_ID, env: APP_ENV }));
    return;
  }

  // --- OAuth: code/refresh_token → user_access_token（密钥不经过前端） ---
  if (pathname === '/api/internal/oauth-token' && req.method === 'POST') {
    log('[internal] oauth-token exchange');
    handleOAuthToken(req, res);
    return;
  }

  // --- 任务 API（需鉴权） ---
  if (pathname === '/api/tasks' || pathname.startsWith('/api/tasks/')) {
    const user = authenticate(req);
    if (!user) return sendJSON(res, 401, { error: '未登录或登录已过期' });
    const taskIdMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/);
    if (req.method === 'GET' && pathname === '/api/tasks') return handleGetTasks(req, res, user);
    if (req.method === 'POST' && pathname === '/api/tasks') return handleCreateTasks(req, res, user);
    if (req.method === 'PUT' && pathname === '/api/tasks') return handleReplaceTasks(req, res, user);
    if (req.method === 'PATCH' && taskIdMatch) return handleUpdateTask(req, res, user, taskIdMatch[1]);
    if (req.method === 'DELETE' && pathname === '/api/tasks') return handleDeleteTasks(req, res, user);
    return sendJSON(res, 405, { error: 'Method not allowed' });
  }

  // --- 图片 API（需鉴权） ---
  if (pathname.startsWith('/api/images/')) {
    const user = authenticate(req);
    if (!user) return sendJSON(res, 401, { error: '未登录或登录已过期' });
    const imgMatch = pathname.match(/^\/api\/images\/([^/]+)\/([^/]+)$/);
    if (!imgMatch) return sendJSON(res, 400, { error: 'Invalid image path, use /api/images/:taskId/:suffix' });
    const [, taskId, suffix] = imgMatch;
    if (req.method === 'POST') return handleUploadImage(req, res, user, taskId, suffix);
    if (req.method === 'GET') return handleGetImage(req, res, user, taskId, suffix);
    if (req.method === 'DELETE') return handleDeleteImage(req, res, user, taskId, suffix);
    return sendJSON(res, 405, { error: 'Method not allowed' });
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
  ensureDir(DATA_DIR);
  cleanExpiredImages();
  log('='.repeat(50));
  log('  名片扫描助手 - 服务已启动');
  log(`  运行环境: ${APP_ENV}`);
  log(`  数据目录: ${DATA_DIR}`);
  log(`  访问地址: http://localhost:${PORT}`);
  log('  密钥状态:');
  log(`    FEISHU_APP_ID:     ${FEISHU_APP_ID ? '✓ 已配置' : '✗ 未配置'}`);
  log(`    FEISHU_APP_SECRET: ${FEISHU_APP_SECRET ? '✓ 已配置' : '✗ 未配置'}`);
  log(`    DOUBAO_API_KEY:    ${DOUBAO_API_KEY ? '✓ 已配置' : '✗ 未配置'}`);
  log(`    GEMINI_API_KEY:    ${GEMINI_API_KEY ? '✓ 已配置' : '✗ 未配置 (Gemini备用)'}`);
  log('='.repeat(50));
});
