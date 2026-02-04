/**
 * Прокси для Cursor Admin API и сохранение данных в локальную БД.
 * API key: заголовок X-API-Key, переменная CURSOR_API_KEY или значение в БД (таблица settings).
 * Документация: https://cursor.com/docs/account/teams/admin-api
 */
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const db = require('./db');
const invoicePdfParser = require('./lib/invoice-pdf-parser');

/** Логирование процесса загрузки по API (для анализа ошибок). Формат: [SYNC] ISO_TIMESTAMP key=value ... */
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const SYNC_LOG_FILE = process.env.SYNC_LOG_FILE || path.join(DATA_DIR, 'sync.log');
/** Текущий лог-файл сессии загрузки (если идёт runSyncToDB). При set все записи syncLog идут в него. */
let currentSyncLogFile = null;
let syncLogDirEnsured = false;

function syncLog(action, fields = {}) {
  const ts = new Date().toISOString();
  const parts = ['[SYNC]', ts, 'action=' + action];
  Object.entries(fields).forEach(([k, v]) => {
    if (v === undefined || v === null) return;
    let val = typeof v === 'object' ? JSON.stringify(v) : String(v);
    val = val.replace(/\r/g, '').replace(/\n/g, '\\n');
    const escaped = /[\s=]/.test(val) ? '"' + val.replace(/"/g, '\\"') + '"' : val;
    parts.push(k + '=' + escaped);
  });
  const line = parts.join(' ') + '\n';
  const logFile = currentSyncLogFile || SYNC_LOG_FILE;
  try {
    if (!syncLogDirEnsured) {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      syncLogDirEnsured = true;
    }
    fs.appendFileSync(logFile, line, 'utf8');
  } catch (e) {
    console.error('[SYNC] log write failed:', e.message);
  }
}

/** Имя файла лога сессии с timestamp: sync-YYYYMMDD-HHmmss.log */
function getSessionLogFilename() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const h = String(now.getUTCHours()).padStart(2, '0');
  const min = String(now.getUTCMinutes()).padStart(2, '0');
  const s = String(now.getUTCSeconds()).padStart(2, '0');
  return `sync-${y}${m}${d}-${h}${min}${s}.log`;
}

function isApiKeyConfigured() {
  return !!(process.env.CURSOR_API_KEY || db.getApiKey());
}

function getApiKey(req) {
  return req.headers['x-api-key'] || process.env.CURSOR_API_KEY || db.getApiKey();
}

const app = express();
const CURSOR_API = 'https://api.cursor.com';
const PROXY_TIMEOUT_MS = Number(process.env.PROXY_TIMEOUT_MS) || 60000;
const MAX_DAYS = 30;

/** Допустимые префиксы путей для прокси (Admin API). */
const ALLOWED_PATH_PREFIXES = ['/teams/', '/settings/'];

function isPathAllowed(apiPath) {
  return ALLOWED_PATH_PREFIXES.some((p) => apiPath.startsWith(p));
}

// Эндпоинты Admin API для синхронизации в БД. Team Members и Spending Data не храним — запрашиваются при отображении дашборда.
const SYNC_ENDPOINTS = [
  { path: '/teams/audit-logs', method: 'GET', syncType: 'daterange', paginated: true, label: 'Audit Logs' },
  { path: '/teams/daily-usage-data', method: 'POST', syncType: 'daterange', bodyEpoch: true, label: 'Daily Usage Data' },
  { path: '/teams/filtered-usage-events', method: 'POST', syncType: 'daterange', paginated: true, label: 'Usage Events' },
];

// CORS: по умолчанию все origins; для продакшена задайте CORS_ORIGIN (например http://localhost:3333)
const corsOrigin = process.env.CORS_ORIGIN;
app.use(cors(corsOrigin ? { origin: corsOrigin.split(',').map(s => s.trim()) } : {}));
app.use(express.json());
// --- Авторизация настроек: логин/пароль из data/auth.json ---
const AUTH_FILE = path.join(DATA_DIR, 'auth.json');
const SESSION_COOKIE = 'cursor_settings_auth';
const SESSION_SECRET_FILE = path.join(DATA_DIR, 'session_secret');
const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 ч

function getSessionSecret() {
  try {
    const p = SESSION_SECRET_FILE;
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim();
    const secret = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, secret, 'utf8');
    return secret;
  } catch (e) {
    return process.env.SESSION_SECRET || 'default-secret-change-in-production';
  }
}

function loadAuthCredentials() {
  try {
    if (fs.existsSync(AUTH_FILE)) {
      const raw = fs.readFileSync(AUTH_FILE, 'utf8');
      const data = JSON.parse(raw);
      const login = (data.login || data.username || '').toString().trim();
      const password = (data.password || '').toString();
      if (login && password) return { login, password };
    }
  } catch (e) {}
  const defaultLogin = 'admin';
  const defaultPassword = 'admin';
  try {
    fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
    fs.writeFileSync(AUTH_FILE, JSON.stringify({ login: defaultLogin, password: defaultPassword }, null, 2), 'utf8');
  } catch (e) {}
  return { login: defaultLogin, password: defaultPassword };
}

let authCredentials = null;
function getAuthCredentials() {
  if (!authCredentials) authCredentials = loadAuthCredentials();
  return authCredentials;
}

function signSession(login) {
  const secret = getSessionSecret();
  const expiry = Date.now() + SESSION_MAX_AGE_MS;
  const payload = login + '|' + expiry;
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return payload + '.' + sig;
}

function verifySession(token) {
  if (!token || typeof token !== 'string') return null;
  const secret = getSessionSecret();
  const dot = token.lastIndexOf('.');
  if (dot === -1) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  if (sig !== expected) return null;
  const [login, expiry] = payload.split('|');
  if (!login || !expiry || Date.now() > Number(expiry)) return null;
  return login;
}

function requireSettingsAuth(req, res, next) {
  const cookie = req.headers.cookie || '';
  const match = cookie.match(new RegExp(SESSION_COOKIE + '=([^;]+)'));
  const token = match ? decodeURIComponent(match[1].trim()) : null;
  const login = verifySession(token);
  if (login) {
    req.settingsUser = login;
    return next();
  }
  if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
    return res.status(401).json({ error: 'Требуется авторизация' });
  }
  res.redirect(302, '/login.html');
}

// Редирект со старой страницы дашборда на главную (страницу удалили)
app.get('/users-dashboard.html', (req, res) => res.redirect(302, '/index.html'));

app.post('/api/login', (req, res) => {
  const login = (req.body && req.body.login) ? String(req.body.login).trim() : '';
  const password = req.body && req.body.password ? String(req.body.password) : '';
  const cred = getAuthCredentials();
  if (!login || login !== cred.login || password !== cred.password) {
    return res.status(401).json({ error: 'Неверный логин или пароль' });
  }
  const token = signSession(login);
  const maxAgeSec = Math.floor(SESSION_MAX_AGE_MS / 1000);
  res.setHeader('Set-Cookie', SESSION_COOKIE + '=' + encodeURIComponent(token) + '; Path=/; Max-Age=' + maxAgeSec + '; HttpOnly; SameSite=Lax');
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', SESSION_COOKIE + '=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
  res.json({ ok: true });
});

app.get('/api/auth/check', (req, res) => {
  const cookie = req.headers.cookie || '';
  const match = cookie.match(new RegExp(SESSION_COOKIE + '=([^;]+)'));
  const token = match ? decodeURIComponent(match[1].trim()) : null;
  const login = verifySession(token);
  res.json({ authenticated: !!login });
});

// Защищённые страницы настроек: только после входа. Перехват по пути без учёта регистра.
const SETTINGS_PAGES_LOWER = ['admin.html', 'data.html', 'jira-users.html', 'invoices.html', 'audit.html', 'settings.html'];

function isProtectedPagePath(req) {
  const pathname = (req.originalUrl || req.url || req.path || '').split('?')[0].replace(/\/$/, '') || '/';
  const base = path.basename(pathname);
  return SETTINGS_PAGES_LOWER.includes(base.toLowerCase());
}

function serveProtectedPageIfAuth(req, res, next) {
  if (req.method !== 'GET') return next();
  if (!isProtectedPagePath(req)) return next();
  const pathname = (req.originalUrl || req.url || req.path || '').split('?')[0];
  const base = path.basename(pathname).toLowerCase();
  requireSettingsAuth(req, res, () => {
    const file = path.join(__dirname, 'public', base);
    if (fs.existsSync(file)) {
      res.setHeader('Cache-Control', 'no-store');
      res.sendFile(file);
    } else {
      res.status(404).send('Not Found');
    }
  });
}

// 1) Перехват защищённых страниц до любой статики (первая линия)
app.use(serveProtectedPageIfAuth);

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 2) Статика: не отдавать защищённые HTML — только после проверки (вторая линия)
const staticRoot = path.join(__dirname, 'public');
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  if (isProtectedPagePath(req)) {
    return requireSettingsAuth(req, res, () => {
      const base = path.basename((req.originalUrl || req.path || '').split('?')[0]).toLowerCase();
      const file = path.join(staticRoot, base);
      if (fs.existsSync(file)) {
        res.setHeader('Cache-Control', 'no-store');
        res.sendFile(file);
      } else {
        res.status(404).send('Not Found');
      }
    });
  }
  next();
});
app.use(express.static(staticRoot, {
  index: false,
  redirect: false,
}));

// Лимиты Cursor Admin API (запросов в минуту): большинство — 20, /teams/user-spend-limit — 60
const CURSOR_API_LIMIT_DEFAULT = 20;
const CURSOR_API_LIMIT_USER_SPEND = 60;
const CURSOR_RATE_WINDOW_MS = 60 * 1000;
const cursorRateBuckets = { default: [], userSpendLimit: [] };

function getCursorLimitBucket(apiPath) {
  return (apiPath || '').includes('/teams/user-spend-limit') ? 'userSpendLimit' : 'default';
}

function getCursorLimit(bucket) {
  return bucket === 'userSpendLimit' ? CURSOR_API_LIMIT_USER_SPEND : CURSOR_API_LIMIT_DEFAULT;
}

/** Ждать, пока не освободится слот в лимите Cursor API, затем занять слот. */
async function waitCursorRateLimit(apiPath) {
  const bucket = getCursorLimitBucket(apiPath);
  const limit = getCursorLimit(bucket);
  let timestamps = cursorRateBuckets[bucket];
  const now = Date.now();
  const windowStart = now - CURSOR_RATE_WINDOW_MS;
  timestamps = timestamps.filter((t) => t > windowStart);
  while (timestamps.length >= limit && limit > 0) {
    if (timestamps.length === 0) break;
    const oldest = Math.min(...timestamps);
    const waitMs = oldest + CURSOR_RATE_WINDOW_MS - now + 50;
    await new Promise((r) => setTimeout(r, Math.min(60000, Math.max(50, waitMs))));
    const n = Date.now();
    timestamps = timestamps.filter((t) => t > n - CURSOR_RATE_WINDOW_MS);
  }
  timestamps.push(Date.now());
  cursorRateBuckets[bucket] = timestamps;
}

/** Задержка между запросами при синхронизации (распределение нагрузки, см. cursor.com/docs/api). */
const REQUEST_DELAY_MS = Number(process.env.REQUEST_DELAY_MS) || 150;
const RATE_LIMIT_MAX_RETRIES = 5;
const RATE_LIMIT_BACKOFF_BASE_MS = 1000;

// Простой rate limit нашего сервера: N запросов с одного IP в минуту (не логируем заголовки — API key не попадает в логи)
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX) || 120;
const rateLimitMap = new Map();

function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
}

function checkRateLimit(ip) {
  const now = Date.now();
  let bucket = rateLimitMap.get(ip);
  if (!bucket) {
    bucket = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    rateLimitMap.set(ip, bucket);
  }
  if (now >= bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + RATE_LIMIT_WINDOW_MS;
  }
  bucket.count++;
  return bucket.count <= RATE_LIMIT_MAX;
}

function validateDateRange(startDate, endDate) {
  if (!startDate || !endDate) return { ok: false, error: 'Требуются параметры startDate и endDate.' };
  const start = new Date(startDate);
  const end = new Date(endDate);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) return { ok: false, error: 'Неверный формат даты (ожидается YYYY-MM-DD).' };
  if (start > end) return { ok: false, error: 'startDate не может быть позже endDate.' };
  const days = Math.ceil((end - start) / (24 * 60 * 60 * 1000)) + 1;
  if (days > MAX_DAYS) return { ok: false, error: `Период не должен превышать ${MAX_DAYS} дней (сейчас ${days}).` };
  return { ok: true };
}

function validateDateRangeForSync(startDate, endDate) {
  if (!startDate || !endDate) return { ok: false, error: 'Требуются startDate и endDate.' };
  const start = new Date(startDate);
  const end = new Date(endDate);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) return { ok: false, error: 'Неверный формат даты (YYYY-MM-DD).' };
  if (start > end) return { ok: false, error: 'startDate не может быть позже endDate.' };
  return { ok: true };
}

/**
 * Разбить заданный период на отрезки по 30 дней (лимит Cursor API).
 * Следующий чанк начинается ровно на день после конца текущего (cur = chunkEnd + 1 день).
 */
function dateChunks(startDate, endDate) {
  const start = new Date(startDate + 'T00:00:00Z');
  const end = new Date(endDate + 'T00:00:00Z');
  const chunks = [];
  let cur = new Date(start);
  while (cur <= end) {
    const chunkEnd = new Date(cur);
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() + MAX_DAYS - 1);
    if (chunkEnd > end) chunkEnd.setTime(end.getTime());
    chunks.push({
      startDate: cur.toISOString().slice(0, 10),
      endDate: chunkEnd.toISOString().slice(0, 10),
    });
    // Следующий чанк = день после chunkEnd (не setUTCDate(day+1) — иначе при смене месяца cur уезжает назад)
    cur.setTime(chunkEnd.getTime());
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return chunks;
}

/**
 * Запрашиваем только те дни, которых нет в БД: находим «дыры» (непрерывные диапазоны недостающих дат)
 * и разбиваем каждую дыру на чанки по 30 дней. Возвращает { chunks, missingDays, rangesCount }.
 */
function getMissingChunksWithMeta(startDate, endCapped, existingSet) {
  const allDates = datesInRange(startDate, endCapped);
  const missing = allDates.filter((d) => !existingSet.has(d));
  if (missing.length === 0) return { chunks: [], missingDays: 0, rangesCount: 0 };

  const ranges = [];
  let rangeStart = missing[0];
  let rangeEnd = missing[0];
  for (let i = 1; i < missing.length; i++) {
    const prev = new Date(missing[i - 1] + 'T00:00:00Z').getTime();
    const curr = new Date(missing[i] + 'T00:00:00Z').getTime();
    if (curr - prev === 24 * 60 * 60 * 1000) {
      rangeEnd = missing[i];
    } else {
      ranges.push({ startDate: rangeStart, endDate: rangeEnd });
      rangeStart = missing[i];
      rangeEnd = missing[i];
    }
  }
  ranges.push({ startDate: rangeStart, endDate: rangeEnd });

  const chunks = [];
  for (const r of ranges) {
    const subChunks = dateChunks(r.startDate, r.endDate);
    chunks.push(...subChunks);
  }
  return { chunks, missingDays: missing.length, rangesCount: ranges.length };
}

/**
 * Запрос к Cursor Admin API с Basic Auth (для синхронизации).
 * Соблюдает лимиты (20/60 запр/мин), при 429 — exponential backoff (cursor.com/docs/api).
 */
async function cursorFetch(apiKey, apiPath, options = {}, logContext = {}) {
  const { method = 'GET', query = {}, body } = options;
  const url = new URL(apiPath, CURSOR_API);
  Object.entries(query).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  const auth = Buffer.from(apiKey + ':', 'utf8').toString('base64');
  const opts = {
    method,
    headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/json' },
  };
  if (body && method === 'POST') opts.body = JSON.stringify(body);

  const requestPayload = method === 'POST' ? body : query;
  syncLog('request', { endpoint: apiPath, method, ...logContext });
  syncLog('request_body', { endpoint: apiPath, body: JSON.stringify(requestPayload || {}) });

  for (let attempt = 0; attempt <= RATE_LIMIT_MAX_RETRIES; attempt++) {
    await waitCursorRateLimit(apiPath);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);
    opts.signal = controller.signal;
    const startMs = Date.now();
    let r;
    try {
      r = await fetch(url.toString(), opts);
    } catch (fetchErr) {
      clearTimeout(timeoutId);
      syncLog('error', { endpoint: apiPath, error: fetchErr.message || String(fetchErr), durationMs: Date.now() - startMs, ...logContext });
      throw fetchErr;
    }
    clearTimeout(timeoutId);
    const durationMs = Date.now() - startMs;
    const data = await r.json().catch(() => ({}));

    if (r.status === 429 && attempt < RATE_LIMIT_MAX_RETRIES) {
      syncLog('retry', { endpoint: apiPath, status: 429, attempt: attempt + 1, durationMs, ...logContext });
      const waitMs = RATE_LIMIT_BACKOFF_BASE_MS * Math.pow(2, attempt);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      continue;
    }
    if (r.status === 401) {
      syncLog('error', { endpoint: apiPath, status: 401, error: 'INVALID_API_KEY', durationMs, ...logContext });
      throw new Error('INVALID_API_KEY');
    }
    if (!r.ok) {
      const errMsg = data.error || data.message || r.statusText;
      syncLog('error', { endpoint: apiPath, status: r.status, error: errMsg, durationMs, ...logContext });
      syncLog('response_body', { endpoint: apiPath, body: JSON.stringify(data), status: r.status });
      throw new Error(errMsg);
    }
    const responseStr = JSON.stringify(data);
    const maxLogLen = 20000;
    const responseBodyLog = responseStr.length > maxLogLen
      ? responseStr.slice(0, maxLogLen) + ' ... (truncated, total ' + responseStr.length + ' chars)'
      : responseStr;
    syncLog('response', { endpoint: apiPath, status: r.status, durationMs, ...logContext });
    syncLog('response_body', { endpoint: apiPath, body: responseBodyLog, status: r.status });
    return data;
  }
  syncLog('error', { endpoint: apiPath, error: 'Rate limit exceeded', ...logContext });
  throw new Error('Rate limit exceeded. Please try again later.');
}

/** Timestamp (ms или строка) -> YYYY-MM-DD. Строки-числа ("1769701107073") — миллисекунды. */
function toDateKey(ts) {
  if (ts == null) return null;
  let ms;
  if (typeof ts === 'string') {
    const n = Number(ts);
    ms = (ts.trim() !== '' && !isNaN(n)) ? n : new Date(ts).getTime();
  } else {
    ms = Number(ts);
  }
  if (isNaN(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

/** Разобрать ответ Admin API по дням для сохранения в БД (без дублирования по дате). */
function parseResponseToDays(endpoint, response, chunkEndDate) {
  const out = [];
  if (endpoint === '/teams/audit-logs' && Array.isArray(response.events)) {
    const byDate = {};
    for (const e of response.events) {
      const d = toDateKey(e.timestamp);
      if (!d) continue;
      if (!byDate[d]) byDate[d] = [];
      byDate[d].push(e);
    }
    for (const [date, arr] of Object.entries(byDate)) out.push({ date, payload: { events: arr, params: response.params } });
    return out;
  }
  if (endpoint === '/teams/daily-usage-data' && Array.isArray(response.data)) {
    const byDate = {};
    for (const r of response.data) {
      const d = toDateKey(r.date);
      if (!d) continue;
      if (!byDate[d]) byDate[d] = [];
      byDate[d].push(r);
    }
    for (const [date, arr] of Object.entries(byDate)) out.push({ date, payload: { data: arr, period: response.period } });
    return out;
  }
  if (endpoint === '/teams/filtered-usage-events' && Array.isArray(response.usageEvents)) {
    const byDate = {};
    for (const e of response.usageEvents) {
      const d = toDateKey(e.timestamp);
      if (!d) continue;
      if (!byDate[d]) byDate[d] = [];
      byDate[d].push(e);
    }
    for (const [date, arr] of Object.entries(byDate)) out.push({ date, payload: { usageEvents: arr, period: response.period } });
    return out;
  }
  if (endpoint === '/teams/members' && response.teamMembers) {
    out.push({ date: chunkEndDate, payload: response });
    return out;
  }
  if (endpoint === '/teams/spend' && response.teamMemberSpend) {
    out.push({ date: chunkEndDate, payload: response });
    return out;
  }
  return out;
}

// Конфигурация API key (хранится в БД, таблица settings) — только для авторизованных
app.get('/api/config', requireSettingsAuth, (req, res) => {
  res.json({ apiKeyConfigured: isApiKeyConfigured() });
});

app.post('/api/config', requireSettingsAuth, (req, res) => {
  const apiKey = (req.body && req.body.apiKey) ? String(req.body.apiKey).trim() : '';
  if (!apiKey) return res.status(400).json({ error: 'Требуется apiKey в теле запроса.' });
  try {
    db.setApiKey(apiKey);
    res.json({ ok: true, message: 'Ключ сохранён в БД' });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Ошибка записи в БД' });
  }
});

async function doProxy(apiKey, apiPath, method, query, body, res) {
  await waitCursorRateLimit(apiPath);
  const url = new URL(apiPath, CURSOR_API);
  Object.entries(query || {}).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  const auth = Buffer.from(apiKey + ':', 'utf8').toString('base64');
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);
  const opts = {
    method: method || 'GET',
    headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/json' },
    signal: controller.signal,
  };
  if (body && opts.method === 'POST') opts.body = JSON.stringify(body);
  return fetch(url.toString(), opts).then(
    (r) => {
      clearTimeout(timeoutId);
      return r.json().catch(() => ({})).then((data) => {
        if (!r.ok) return res.status(r.status).json(data || { error: r.statusText });
        res.json(data);
      });
    },
    (e) => {
      clearTimeout(timeoutId);
      if (e.name === 'AbortError') return res.status(504).json({ error: 'Таймаут запроса к Cursor API.' });
      res.status(502).json({ error: e.message || 'Proxy request failed' });
    }
  );
}

app.get('/api/proxy', async (req, res) => {
  const ip = getClientIp(req);
  if (!checkRateLimit(ip)) return res.status(429).json({ error: 'Слишком много запросов. Подождите минуту.' });
  const apiKey = getApiKey(req);
  if (!apiKey) return res.status(401).json({ error: 'API key required. Укажите X-API-Key, CURSOR_API_KEY или создайте файл data/api-key.txt.' });
  const apiPath = req.query.path;
  if (!apiPath || !isPathAllowed(apiPath)) {
    return res.status(400).json({ error: 'Query param path required, допустимы /teams/... и /settings/...' });
  }
  const query = { ...req.query };
  delete query.path;
  if (req.query.startDate && req.query.endDate) {
    const validation = validateDateRange(req.query.startDate, req.query.endDate);
    if (!validation.ok) return res.status(400).json({ error: validation.error });
  }
  return doProxy(apiKey, apiPath, 'GET', query, null, res).catch((e) => res.status(500).json({ error: e.message }));
});

app.post('/api/proxy', async (req, res) => {
  const ip = getClientIp(req);
  if (!checkRateLimit(ip)) return res.status(429).json({ error: 'Слишком много запросов. Подождите минуту.' });
  const apiKey = getApiKey(req);
  if (!apiKey) return res.status(401).json({ error: 'Введите и сохраните API key для выгрузки.', code: 'API_KEY_REQUIRED' });
  const { path: apiPath, ...body } = req.body || {};
  if (!apiPath || !isPathAllowed(apiPath)) {
    return res.status(400).json({ error: 'Body path required, допустимы /teams/... и /settings/...' });
  }
  return doProxy(apiKey, apiPath, 'POST', {}, body, res).catch((e) => res.status(500).json({ error: e.message }));
});

// --- Синхронизация Admin API в локальную БД (без дублирования по дням) ---

function dateToEpochMs(dateStr) {
  return new Date(dateStr + 'T00:00:00Z').getTime();
}

/** Вчера в YYYY-MM-DD (текущий день не загружаем — сутки не окончены). */
function getYesterdayStr() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Список дат от start до end включительно (YYYY-MM-DD). */
function datesInRange(startStr, endStr) {
  const start = new Date(startStr + 'T00:00:00Z');
  const end = new Date(endStr + 'T00:00:00Z');
  const out = [];
  const cur = new Date(start);
  while (cur <= end) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

/** Для каждого daterange-эндпоинта возвращает { chunks, missingDays, rangesCount } по недостающим диапазонам. */
function getChunksToFetch(startDate, endCapped) {
  const result = {};
  for (const ep of SYNC_ENDPOINTS) {
    if (ep.syncType !== 'daterange') continue;
    const existingSet = new Set(db.getExistingDates(ep.path, startDate, endCapped));
    result[ep.path] = getMissingChunksWithMeta(startDate, endCapped, existingSet);
  }
  return result;
}

/** Подсчёт числа шагов синхронизации: снимки + только те чанки, что реально будем загружать. */
function getSyncTotalSteps(chunksToFetchByEndpoint) {
  let steps = 0;
  for (const ep of SYNC_ENDPOINTS) {
    if (ep.syncType === 'snapshot') steps += 1;
    else steps += (chunksToFetchByEndpoint[ep.path]?.chunks || []).length;
  }
  return steps;
}

function isFeatureNotEnabled(msg) {
  return msg && /not enabled|feature is not enabled/i.test(String(msg));
}

/**
 * Выполняет синхронизацию в БД. Загружаются только те дни, которых ещё нет в БД; текущий день не загружается.
 * onProgress вызывается с phase 'requesting' (перед запросом) и 'saved' (после сохранения); для постраничных — с page.
 * Возвращает { message, saved, ok, errors, skipped }.
 */
async function runSyncToDB(apiKey, startDate, endDate, onProgress) {
  const logDir = DATA_DIR;
  const sessionLogPath = path.join(logDir, getSessionLogFilename());
  const prevLogFile = currentSyncLogFile;
  currentSyncLogFile = sessionLogPath;
  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch (e) {}

  const yesterday = getYesterdayStr();
  const endCapped = !endDate || endDate > yesterday ? yesterday : endDate;
  const chunksToFetch = getChunksToFetch(startDate, endCapped);
  const totalSteps = getSyncTotalSteps(chunksToFetch);
  const results = { ok: [], errors: [], skipped: [], saved: 0 };
  let currentStep = 0;

  syncLog('start', { startDate, endDate, endCapped, totalSteps, sessionLog: path.basename(sessionLogPath) });

  try {
  for (const ep of SYNC_ENDPOINTS) {
    try {
      let savedForEp = 0;
      if (ep.syncType === 'snapshot') {
        if (onProgress) {
          onProgress({
            phase: 'requesting',
            endpointLabel: ep.label || ep.path,
            endpointPath: ep.path,
            chunkLabel: null,
            stepLabel: 'Запрос снимка (текущее состояние)',
          });
        }
        const chunkEnd = yesterday;
        const response = await cursorFetch(apiKey, ep.path, {
          method: ep.method,
          query: ep.method === 'GET' ? {} : undefined,
          body: ep.method === 'POST' ? {} : undefined,
        }, { endpointLabel: ep.label, chunkLabel: 'snapshot' });
        const rows = parseResponseToDays(ep.path, response, chunkEnd);
        for (const { date, payload } of rows) {
          db.upsertAnalytics(ep.path, date, payload);
          savedForEp++;
        }
        syncLog('saved', { endpoint: ep.path, endpointLabel: ep.label, records: savedForEp, days: rows.length });
        currentStep++;
        if (onProgress) {
          onProgress({
            phase: 'saved',
            currentStep,
            totalSteps,
            endpointLabel: ep.label || ep.path,
            endpointPath: ep.path,
            chunkLabel: null,
            savedInStep: savedForEp,
            totalSaved: results.saved + savedForEp,
            daysInStep: rows.length,
          });
        }
      } else {
        const chunks = chunksToFetch[ep.path]?.chunks || [];
        for (const { startDate: chunkStart, endDate: chunkEnd } of chunks) {
          const chunkLabel = `${chunkStart} – ${chunkEnd}`;
          if (onProgress) {
            onProgress({
              phase: 'requesting',
              endpointLabel: ep.label || ep.path,
              endpointPath: ep.path,
              chunkLabel,
              stepLabel: ep.paginated ? `Запрос периода (постранично)` : `Запрос периода`,
            });
          }
          let response;
          if (ep.path === '/teams/audit-logs') {
            const allEvents = [];
            let page = 1;
            const pageSize = 100;
            let hasNext = true;
            while (hasNext) {
              if (onProgress) {
                onProgress({
                  phase: 'requesting',
                  subPhase: 'page',
                  endpointLabel: ep.label || ep.path,
                  chunkLabel,
                  page,
                  stepLabel: `Запрос страницы ${page}`,
                });
              }
              response = await cursorFetch(apiKey, ep.path, {
                method: 'GET',
                query: { startTime: chunkStart, endTime: chunkEnd, page, pageSize },
              }, { endpointLabel: ep.label, chunkLabel, page });
              if (Array.isArray(response.events)) allEvents.push(...response.events);
              hasNext = response.pagination?.hasNextPage === true;
              page++;
            }
            response = { events: allEvents, params: response.params };
          } else if (ep.path === '/teams/daily-usage-data') {
            response = await cursorFetch(apiKey, ep.path, {
              method: 'POST',
              body: {
                startDate: dateToEpochMs(chunkStart),
                endDate: dateToEpochMs(chunkEnd),
              },
            }, { endpointLabel: ep.label, chunkLabel });
          } else if (ep.path === '/teams/filtered-usage-events') {
            const allEvents = [];
            let page = 1;
            const pageSize = 100;
            let hasNext = true;
            while (hasNext) {
              if (onProgress) {
                onProgress({
                  phase: 'requesting',
                  subPhase: 'page',
                  endpointLabel: ep.label || ep.path,
                  chunkLabel,
                  page,
                  stepLabel: `Запрос страницы ${page}`,
                });
              }
              response = await cursorFetch(apiKey, ep.path, {
                method: 'POST',
                body: {
                  startDate: dateToEpochMs(chunkStart),
                  endDate: dateToEpochMs(chunkEnd),
                  page,
                  pageSize,
                },
              }, { endpointLabel: ep.label, chunkLabel, page });
              if (Array.isArray(response.usageEvents)) allEvents.push(...response.usageEvents);
              hasNext = response.pagination?.hasNextPage === true;
              page++;
            }
            response = {
              totalUsageEventsCount: response.totalUsageEventsCount,
              pagination: response.pagination ? { ...response.pagination, hasNextPage: false } : null,
              usageEvents: allEvents,
              period: response.period,
            };
          } else {
            continue;
          }
          const rows = parseResponseToDays(ep.path, response, chunkEnd);
          let stepSaved = 0;
          if (rows.length === 0) {
            const emptyPayload =
              ep.path === '/teams/audit-logs' ? { events: [], params: response.params || {} }
                : ep.path === '/teams/daily-usage-data' ? { data: [], period: response.period || {} }
                  : ep.path === '/teams/filtered-usage-events' ? { totalUsageEventsCount: response.totalUsageEventsCount ?? 0, pagination: response.pagination || null, usageEvents: [], period: response.period || {} }
                    : null;
            if (emptyPayload) {
              const daysInChunk = datesInRange(chunkStart, chunkEnd);
              for (const date of daysInChunk) {
                db.upsertAnalytics(ep.path, date, emptyPayload);
                savedForEp++;
                stepSaved++;
              }
              syncLog('saved', { endpoint: ep.path, endpointLabel: ep.label, chunkLabel, records: stepSaved, days: stepSaved, empty: true });
            }
          } else {
            const savedDates = new Set();
            for (const { date, payload } of rows) {
              db.upsertAnalytics(ep.path, date, payload);
              savedForEp++;
              stepSaved++;
              savedDates.add(date);
            }
            // API для Audit Logs и Usage Events возвращает только дни с событиями. Дни без событий
            // не приходят — дописываем их пустыми, чтобы они не считались «отсутствующими» при следующей синхронизации.
            const daysInChunk = datesInRange(chunkStart, chunkEnd);
            const emptyPayload =
              ep.path === '/teams/audit-logs' ? { events: [], params: response.params || {} }
                : ep.path === '/teams/daily-usage-data' ? { data: [], period: response.period || {} }
                  : ep.path === '/teams/filtered-usage-events' ? { totalUsageEventsCount: response.totalUsageEventsCount ?? 0, pagination: response.pagination || null, usageEvents: [], period: response.period || {} }
                    : null;
            if (emptyPayload) {
              for (const date of daysInChunk) {
                if (savedDates.has(date)) continue;
                db.upsertAnalytics(ep.path, date, emptyPayload);
                savedForEp++;
                stepSaved++;
              }
            }
            syncLog('saved', { endpoint: ep.path, endpointLabel: ep.label, chunkLabel, records: stepSaved, days: rows.length, filledEmpty: stepSaved - rows.length });
          }
          currentStep++;
          if (onProgress) {
            onProgress({
              phase: 'saved',
              currentStep,
              totalSteps,
              endpointLabel: ep.label || ep.path,
              endpointPath: ep.path,
              chunkLabel,
              savedInStep: stepSaved,
              totalSaved: results.saved + savedForEp,
              daysInStep: stepSaved,
            });
          }
        }
      }
      results.saved += savedForEp;
      results.ok.push(ep.path);
    } catch (e) {
      if (isFeatureNotEnabled(e.message)) {
        syncLog('skipped', { endpoint: ep.path, reason: 'feature_not_enabled' });
        results.skipped.push({ endpoint: ep.path, reason: 'Функция не включена для команды' });
        results.ok.push(ep.path);
      } else {
        syncLog('error', { endpoint: ep.path, error: e.message, step: 'runSyncToDB' });
        results.errors.push({ endpoint: ep.path, error: e.message });
      }
    }
  }

  const skippedNote = results.skipped.length ? ` Пропущено (функция не включена): ${results.skipped.length}.` : '';
  syncLog('complete', {
    saved: results.saved,
    okCount: results.ok.length,
    errorsCount: results.errors.length,
    skippedCount: results.skipped.length,
    errors: results.errors.length ? results.errors.map((e) => e.endpoint + ':' + e.error).join('; ') : undefined,
  });
  return {
    message: `Сохранено записей по дням: ${results.saved}. Успешно: ${results.ok.length}, ошибок: ${results.errors.length}.${skippedNote}`,
    saved: results.saved,
    ok: results.ok,
    errors: results.errors,
    skipped: results.skipped,
  };
  } finally {
    currentSyncLogFile = prevLogFile;
  }
}

app.post('/api/sync', requireSettingsAuth, async (req, res) => {
  const apiKey = getApiKey(req);
  if (!apiKey) return res.status(401).json({ error: 'API key required. Укажите X-API-Key, CURSOR_API_KEY или создайте файл data/api-key.txt.' });
  const { startDate, endDate } = req.body || {};
  const validation = validateDateRangeForSync(startDate, endDate);
  if (!validation.ok) return res.status(400).json({ error: validation.error });
  try {
    const data = await runSyncToDB(apiKey, startDate, endDate || new Date().toISOString().slice(0, 10), null);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Синхронизация с потоковой отдачей прогресса (SSE). */
app.post('/api/sync-stream', requireSettingsAuth, async (req, res) => {
  const apiKey = getApiKey(req);
  if (!apiKey) {
    res.setHeader('Content-Type', 'application/json');
    return res.status(401).json({ error: 'Введите и сохраните API key для выгрузки.', code: 'API_KEY_REQUIRED' });
  }
  const { startDate, endDate } = req.body || {};
  const validation = validateDateRangeForSync(startDate, endDate);
  if (!validation.ok) {
    res.setHeader('Content-Type', 'application/json');
    return res.status(400).json({ error: validation.error });
  }
  const end = endDate || new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders && res.flushHeaders();

  function send(event) {
    res.write('data: ' + JSON.stringify(event) + '\n\n');
  }

  try {
    const yesterday = getYesterdayStr();
    const endCapped = !end || end > yesterday ? yesterday : end;
    const chunksToFetch = getChunksToFetch(startDate, endCapped);
    const totalSteps = getSyncTotalSteps(chunksToFetch);
    const breakdown = SYNC_ENDPOINTS.map((ep) => {
      if (ep.syncType === 'snapshot') {
        return { endpointLabel: ep.label || ep.path, type: 'snapshot' };
      }
      const meta = chunksToFetch[ep.path] || { chunks: [], missingDays: 0, rangesCount: 0 };
      const chunksCount = meta.chunks.length;
      return {
        endpointLabel: ep.label || ep.path,
        type: 'daterange',
        chunksCount,
        missingDays: meta.missingDays,
        rangesCount: meta.rangesCount,
      };
    });
    send({
      type: 'plan',
      startDate,
      endCapped,
      totalSteps,
      breakdown,
    });
    const result = await runSyncToDB(apiKey, startDate, end, (p) => send({ type: 'progress', ...p }));
    send({ type: 'done', ...result });
  } catch (e) {
    if (e.message === 'INVALID_API_KEY') send({ type: 'error', error: 'API key недействителен. Введите новый ключ и нажмите «Сохранить ключ».', code: 'INVALID_API_KEY' });
    else send({ type: 'error', error: e.message });
  } finally {
    res.end();
  }
});

app.get('/api/analytics', requireSettingsAuth, (req, res) => {
  try {
    const rows = db.getAnalytics({
      endpoint: req.query.endpoint || undefined,
      startDate: req.query.startDate || undefined,
      endDate: req.query.endDate || undefined,
    });
    res.json({ data: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/analytics/coverage', requireSettingsAuth, (req, res) => {
  try {
    const coverage = db.getCoverage();
    res.json({ coverage });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Полная очистка БД: analytics и jira_users; при clearSettings: true — также settings (API key). */
app.post('/api/clear-db', requireSettingsAuth, (req, res) => {
  try {
    const clearSettings = !!(req.body && req.body.clearSettings);
    db.clearAllData(clearSettings);
    res.json({
      ok: true,
      message: clearSettings
        ? 'БД полностью очищена (аналитика, пользователи Jira, настройки).'
        : 'БД очищена: аналитика и пользователи Jira. Настройки (API key) сохранены.',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Очистка только данных API (analytics). */
app.post('/api/clear-analytics', requireSettingsAuth, (req, res) => {
  try {
    db.clearAnalyticsOnly();
    res.json({ ok: true, message: 'Данные API (аналитика) очищены.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Очистка только данных Jira (jira_users). */
app.post('/api/clear-jira', requireSettingsAuth, (req, res) => {
  try {
    db.clearJiraOnly();
    res.json({ ok: true, message: 'Данные Jira очищены.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Дашборд пользователей: Jira + активность Cursor по неделям ---

/** Ключ месяца YYYY-MM для даты YYYY-MM-DD */
function getMonthKey(dateStr) {
  if (!dateStr || String(dateStr).length < 7) return null;
  return String(dateStr).slice(0, 7);
}

/** Найти ключ с email в объекте Jira (приоритет: известные имена, затем значение с @) */
function getEmailFromJiraRow(row, allKeys) {
  const emailKeys = ['Внешний почтовый адрес', 'Email', 'email', 'E-mail', 'e-mail', 'Почта'];
  for (const k of emailKeys) {
    if (row[k] != null && String(row[k]).includes('@')) return String(row[k]).trim().toLowerCase();
  }
  for (const k of allKeys || Object.keys(row)) {
    const v = row[k];
    if (v != null && String(v).includes('@')) return String(v).trim().toLowerCase();
  }
  return null;
}

/** Значение статуса из строки Jira → 'active' | 'archived'. Учитываются Статус, Status, Состояние. */
function getJiraStatusFromRow(row) {
  const statusKeys = ['Статус', 'Status', 'Состояние', 'State'];
  let raw = '';
  for (const k of statusKeys) {
    if (row[k] != null && String(row[k]).trim() !== '') {
      raw = String(row[k]).trim().toLowerCase();
      break;
    }
  }
  if (!raw) return 'active';
  const archivedTerms = ['архив', 'archived', 'неактив', 'inactive', 'отключ', 'disabled', 'закрыт', 'closed'];
  return archivedTerms.some((t) => raw.includes(t)) ? 'archived' : 'active';
}

/** Проект из строки Jira (название или ключ проекта). */
function getJiraProjectFromRow(row) {
  const projectKeys = ['Проект', 'Project', 'Project key', 'Название проекта', 'Project name', 'Проект / Project'];
  for (const k of projectKeys) {
    const v = row[k];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return null;
}

/** Приоритетное поле для выбора актуальной записи при дубликатах пользователя: самая свежая дата начала подписки. */
const JIRA_SUBSCRIPTION_START_KEYS = ['Дата начала подписки', 'Subscription start date', 'Subscription start', 'Дата подписки', 'Start date'];
const JIRA_DATE_KEYS = ['Дата', 'Date', 'Created', 'Создан', 'Обновлён', 'Updated', 'Дата изменения', 'Дата выдачи'];

/** Парсит дату из Jira: ДД.ММ.ГГГГ, ДД.ММ.ГГГГ ЧЧ:мм или ISO/другие форматы. Возвращает Date или null. */
function parseJiraDateStr(str) {
  if (str == null || String(str).trim() === '') return null;
  const s = String(str).trim();
  const ddmmyyyy = /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
  const m = s.match(ddmmyyyy);
  if (m) {
    const day = parseInt(m[1], 10);
    const month = parseInt(m[2], 10) - 1;
    const year = parseInt(m[3], 10);
    const hour = m[4] != null ? parseInt(m[4], 10) : 0;
    const min = m[5] != null ? parseInt(m[5], 10) : 0;
    const sec = m[6] != null ? parseInt(m[6], 10) : 0;
    const d = new Date(year, month, day, hour, min, sec);
    if (!isNaN(d.getTime())) return d;
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

/** Дата из строки Jira в формате YYYY-MM-DD (для отображения подключения/отключения). */
function getJiraDateFromRow(row) {
  const keys = [...JIRA_SUBSCRIPTION_START_KEYS, ...JIRA_DATE_KEYS];
  for (const k of keys) {
    const v = row[k];
    const d = parseJiraDateStr(v);
    if (d) return d.toISOString().slice(0, 10);
  }
  return null;
}

/** Ключ сортировки строки Jira: запись с самой свежей датой начала подписки = актуальный статус. Сначала «Дата начала подписки», затем остальные даты. */
function getJiraRowOrderKey(row, id) {
  const dateKeys = [...JIRA_SUBSCRIPTION_START_KEYS, ...JIRA_DATE_KEYS];
  for (const k of dateKeys) {
    const v = row[k];
    const d = parseJiraDateStr(v);
    if (d) return d.getTime();
  }
  return id;
}

/** Снимок Team Members и Spending Data из Cursor API (для отдельного дашборда). */
app.get('/api/teams/snapshot', async (req, res) => {
  try {
    const apiKey = getApiKey(req);
    if (!apiKey) {
      return res.status(401).json({ error: 'API key не задан. Укажите X-API-Key или настройте ключ в Настройках.' });
    }
    const [membersResp, spendResp] = await Promise.all([
      cursorFetch(apiKey, '/teams/members', { method: 'GET' }),
      cursorFetch(apiKey, '/teams/spend', { method: 'POST', body: {} }),
    ]);
    const list = membersResp?.teamMembers;
    const teamMembers = Array.isArray(list)
      ? list.map((m) => ({
          email: (m.email || m.userEmail || m.user_email || '').toString().trim().toLowerCase(),
          name: (m.name || m.displayName || m.display_name || m.email || '').toString().trim(),
        })).filter((m) => m.email || m.name)
      : [];
    const spendList = spendResp?.teamMemberSpend;
    const teamMemberSpend = Array.isArray(spendList)
      ? spendList.map((s) => {
          const email = (s.userEmail || s.email || s.user_email || '').toString().trim().toLowerCase();
          const cents = Number(s.cents ?? s.totalCents ?? s.spendCents ?? s.amount ?? 0) || 0;
          return { email, cents };
        }).filter((s) => s.email)
      : [];
    let totalSpendCents = 0;
    for (const s of teamMemberSpend) totalSpendCents += s.cents;
    res.json({
      teamMembers,
      teamMembersCount: teamMembers.length,
      teamMemberSpend,
      totalSpendCents,
    });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Ошибка запроса к Cursor API' });
  }
});

/** Агрегация активности по пользователям и месяцам только по данным из БД (Daily Usage Data + Usage Events Data). */
app.get('/api/users/activity-by-month', (req, res) => {
  try {
    const startDate = req.query.startDate;
    const endDate = req.query.endDate;
    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'Нужны параметры startDate и endDate (YYYY-MM-DD).' });
    }
    const jiraRows = db.getJiraUsers();
    const jiraUsers = jiraRows.map((r) => r.data);
    const allKeys = jiraUsers.length ? getAllKeysFromRows(jiraUsers) : [];
    const emailByMonth = new Map();
    const monthSet = new Set();

    // Daily Usage Data: активные дни, запросы, строки, applies/accepts
    const dailyRows = db.getAnalytics({
      endpoint: '/teams/daily-usage-data',
      startDate,
      endDate,
    });
    for (const row of dailyRows) {
      const payload = row.payload || {};
      const data = payload.data;
      if (!Array.isArray(data)) continue;
      for (const r of data) {
        const email = (r.email || r.user_email || r.userEmail || '').toString().trim().toLowerCase();
        if (!email) continue;
        let dateStr = '';
        if (r.date != null) {
          if (typeof r.date === 'number') dateStr = new Date(r.date).toISOString().slice(0, 10);
          else dateStr = String(r.date).slice(0, 10);
        }
        if (!dateStr || dateStr.length < 10) dateStr = row.date || '';
        if (!dateStr || dateStr.length < 10) continue;
        const month = getMonthKey(dateStr);
        if (!month) continue;
        monthSet.add(month);
        const key = email + '\n' + month;
        let rec = emailByMonth.get(key);
        if (!rec) {
          rec = { month, lastDate: null, activeDays: 0, requests: 0, linesAdded: 0, linesDeleted: 0, applies: 0, accepts: 0, usageEventsCount: 0, usageCostCents: 0, usageRequestsCosts: 0, usageCostByModel: {} };
          emailByMonth.set(key, rec);
        }
        rec.activeDays += 1;
        if (dateStr && (!rec.lastDate || dateStr > rec.lastDate)) rec.lastDate = dateStr;
        rec.requests += Number(r.composer_requests ?? r.composerRequests ?? 0) + Number(r.chat_requests ?? r.chatRequests ?? 0) + Number(r.agent_requests ?? r.agentRequests ?? 0);
        rec.linesAdded += Number(r.total_lines_added ?? r.totalLinesAdded ?? 0) + Number(r.accepted_lines_added ?? r.acceptedLinesAdded ?? 0);
        rec.linesDeleted += Number(r.total_lines_deleted ?? r.totalLinesDeleted ?? 0) + Number(r.accepted_lines_deleted ?? r.acceptedLinesDeleted ?? 0);
        rec.applies += Number(r.total_applies ?? r.totalApplies ?? 0);
        rec.accepts += Number(r.total_accepts ?? r.totalAccepts ?? 0);
      }
    }

    // Usage Events Data (Get Usage Events Data): события, стоимость, requestsCosts
    const usageEventsRows = db.getAnalytics({
      endpoint: '/teams/filtered-usage-events',
      startDate,
      endDate,
    });
    for (const row of usageEventsRows) {
      const payload = row.payload || {};
      const events = payload.usageEvents;
      if (!Array.isArray(events)) continue;
      for (const e of events) {
        const email = (e.userEmail || e.user_email || e.email || '').toString().trim().toLowerCase();
        if (!email) continue;
        const dateStr = toDateKey(e.timestamp);
        if (!dateStr || dateStr.length < 10) continue;
        const month = getMonthKey(dateStr);
        if (!month) continue;
        monthSet.add(month);
        const key = email + '\n' + month;
        let rec = emailByMonth.get(key);
        if (!rec) {
          rec = { month, lastDate: null, activeDays: 0, requests: 0, linesAdded: 0, linesDeleted: 0, applies: 0, accepts: 0, usageEventsCount: 0, usageCostCents: 0, usageRequestsCosts: 0, usageInputTokens: 0, usageOutputTokens: 0, usageCacheWriteTokens: 0, usageCacheReadTokens: 0, usageTokenCents: 0, usageCostByModel: {} };
          emailByMonth.set(key, rec);
        }
        rec.usageEventsCount += 1;
        if (dateStr && (!rec.lastDate || dateStr > rec.lastDate)) rec.lastDate = dateStr;
        rec.usageRequestsCosts += Number(e.requestsCosts ?? 0);
        const tu = e.tokenUsage || {};
        const tokenCents = Number(tu.totalCents ?? 0) || 0;
        const cursorFee = Number(e.cursorTokenFee ?? 0) || 0;
        rec.usageCostCents += tokenCents + cursorFee;
        rec.usageInputTokens = (rec.usageInputTokens || 0) + Number(tu.inputTokens ?? 0);
        rec.usageOutputTokens = (rec.usageOutputTokens || 0) + Number(tu.outputTokens ?? 0);
        rec.usageCacheWriteTokens = (rec.usageCacheWriteTokens || 0) + Number(tu.cacheWriteTokens ?? 0);
        rec.usageCacheReadTokens = (rec.usageCacheReadTokens || 0) + Number(tu.cacheReadTokens ?? 0);
        rec.usageTokenCents = (rec.usageTokenCents || 0) + tokenCents;
        const modelKey = (e.model || e.modelId || e.modelName || e.providerModelId || '').toString().trim() || 'Другое';
        rec.usageCostByModel[modelKey] = (rec.usageCostByModel[modelKey] || 0) + tokenCents + cursorFee;
      }
    }

    const months = Array.from(monthSet).sort();
    const users = [];
    const jiraEmails = new Set();
    // По каждому email: первая и последняя дата по всем строкам Jira, последняя запись для статуса/имени
    const emailToJiraInfo = new Map();
    for (let i = 0; i < jiraRows.length; i++) {
      const { id, data: jira } = jiraRows[i];
      const email = getEmailFromJiraRow(jira, allKeys);
      if (!email) continue;
      jiraEmails.add(email);
      const orderKey = getJiraRowOrderKey(jira, id);
      const rowDate = getJiraDateFromRow(jira);
      const existing = emailToJiraInfo.get(email);
      const firstDate = !rowDate ? (existing?.firstDate ?? null) : (!existing?.firstDate || rowDate < existing.firstDate ? rowDate : existing.firstDate);
      const lastDate = !rowDate ? (existing?.lastDate ?? null) : (!existing?.lastDate || rowDate > existing.lastDate ? rowDate : existing.lastDate);
      if (!existing || orderKey > existing.orderKey) {
        emailToJiraInfo.set(email, { jira, id, orderKey, firstDate, lastDate });
      } else {
        emailToJiraInfo.set(email, { ...existing, firstDate, lastDate });
      }
    }
    for (const [email, { jira, firstDate, lastDate }] of emailToJiraInfo) {
      const displayName = jira['Пользователь, которому выдан доступ'] || jira['Display Name'] || jira['Username'] || jira['Name'] || email || '—';
      const jiraStatus = getJiraStatusFromRow(jira);
      const jiraProject = getJiraProjectFromRow(jira);
      const monthlyActivity = months.map((month) => {
        const rec = emailByMonth.get(email + '\n' + month);
        const def = { month, lastDate: null, activeDays: 0, requests: 0, linesAdded: 0, linesDeleted: 0, applies: 0, accepts: 0, usageEventsCount: 0, usageCostCents: 0, usageRequestsCosts: 0, usageInputTokens: 0, usageOutputTokens: 0, usageCacheWriteTokens: 0, usageCacheReadTokens: 0, usageTokenCents: 0, usageCostByModel: {} };
        if (!rec) return def;
        return { ...def, ...rec, usageCostByModel: { ...def.usageCostByModel, ...(rec.usageCostByModel || {}) } };
      });
      const jiraConnectedAt = firstDate || null;
      const jiraDisconnectedAt = jiraStatus === 'archived' && lastDate ? lastDate : null;
      users.push({ jira, email, displayName: String(displayName), jiraStatus, jiraProject, jiraConnectedAt, jiraDisconnectedAt, monthlyActivity });
    }
    const cursorOnlyEmails = new Set();
    for (const key of emailByMonth.keys()) {
      const email = key.split('\n')[0];
      if (email && !jiraEmails.has(email)) cursorOnlyEmails.add(email);
    }
    for (const email of cursorOnlyEmails) {
      const monthlyActivity = months.map((month) => {
        const rec = emailByMonth.get(email + '\n' + month);
        const def = { month, lastDate: null, activeDays: 0, requests: 0, linesAdded: 0, linesDeleted: 0, applies: 0, accepts: 0, usageEventsCount: 0, usageCostCents: 0, usageRequestsCosts: 0, usageInputTokens: 0, usageOutputTokens: 0, usageCacheWriteTokens: 0, usageCacheReadTokens: 0, usageTokenCents: 0, usageCostByModel: {} };
        if (!rec) return def;
        return { ...def, ...rec, usageCostByModel: { ...def.usageCostByModel, ...(rec.usageCostByModel || {}) } };
      });
      users.push({ jira: {}, email, displayName: email, jiraStatus: null, jiraProject: null, jiraConnectedAt: null, jiraDisconnectedAt: null, monthlyActivity });
    }

    // lastActivityMonth, lastActivityDate и totalRequestsInPeriod по каждому пользователю
    const lastMonthInRange = months.length ? months[months.length - 1] : null;
    for (const u of users) {
      let lastActivityMonth = null;
      let lastActivityDate = null;
      let totalRequests = 0;
      for (const a of u.monthlyActivity || []) {
        totalRequests += a.requests || 0;
        if ((a.requests || 0) + (a.usageEventsCount || 0) > 0) {
          lastActivityMonth = a.month;
          const d = a.lastDate || null;
          if (d && (!lastActivityDate || d > lastActivityDate)) lastActivityDate = d;
        }
      }
      u.lastActivityMonth = lastActivityMonth;
      u.lastActivityDate = lastActivityDate;
      u.totalRequestsInPeriod = totalRequests;
    }

    // Team Members и Spending Data — только из БД не берём; отдельный дашборд /team-snapshot.html запрашивает их через API
    for (const u of users) {
      u.teamSpendCents = 0;
    }
    const totalTeamSpendCents = 0;
    const teamMembersCount = 0;
    const teamMembers = [];

    // Активные в Jira, но не используют / редко используют Cursor (после назначения teamSpendCents)
    const activeJiraButInactiveCursor = users.filter((u) => {
      if (u.jiraStatus === 'archived' || u.jiraStatus == null) return false;
      const noUse = (u.totalRequestsInPeriod || 0) === 0;
      const noRecentUse = lastMonthInRange && (u.lastActivityMonth == null || u.lastActivityMonth < lastMonthInRange);
      const rarelyUse = (u.totalRequestsInPeriod || 0) > 0 && (u.totalRequestsInPeriod || 0) < 5;
      return noUse || noRecentUse || rarelyUse;
    }).map((u) => ({
      email: u.email,
      displayName: u.displayName,
      jiraProject: u.jiraProject,
      jiraStatus: u.jiraStatus,
      jiraConnectedAt: u.jiraConnectedAt,
      jiraDisconnectedAt: u.jiraDisconnectedAt,
      lastActivityMonth: u.lastActivityMonth,
      lastActivityDate: u.lastActivityDate,
      totalRequestsInPeriod: u.totalRequestsInPeriod,
      teamSpendCents: u.teamSpendCents,
    }));

    // Затраты по проекту помесячно (usageCostCents по месяцам)
    const costByProjectByMonth = {};
    for (const u of users) {
      const projectKey = u.jiraProject && String(u.jiraProject).trim() ? String(u.jiraProject).trim() : '— Без проекта';
      if (!costByProjectByMonth[projectKey]) costByProjectByMonth[projectKey] = {};
      for (const a of u.monthlyActivity || []) {
        const month = a.month;
        if (!month) continue;
        const cur = costByProjectByMonth[projectKey][month] || { usageCostCents: 0, usageEventsCount: 0 };
        cur.usageCostCents = (cur.usageCostCents || 0) + (a.usageCostCents || 0);
        cur.usageEventsCount = (cur.usageEventsCount || 0) + (a.usageEventsCount || 0);
        costByProjectByMonth[projectKey][month] = cur;
      }
    }
    // Сумма за отображаемый период по каждому проекту (usageCostCents по месяцам)
    const projectTotals = {};
    for (const [projectKey, byMonth] of Object.entries(costByProjectByMonth)) {
      let sum = 0;
      for (const cur of Object.values(byMonth)) {
        sum += cur.usageCostCents || 0;
      }
      projectTotals[projectKey] = sum;
    }

    res.json({
      users,
      months,
      totalTeamSpendCents,
      teamMembersCount,
      teamMembers,
      activeJiraButInactiveCursor,
      costByProjectByMonth,
      projectTotals,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** События Audit Logs для страницы аудита и блока на дашборде. */
app.get('/api/audit-events', requireSettingsAuth, (req, res) => {
  try {
    const startDate = req.query.startDate || undefined;
    const endDate = req.query.endDate || undefined;
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const eventType = (req.query.eventType || '').trim() || undefined;
    const rows = db.getAnalytics({
      endpoint: '/teams/audit-logs',
      startDate,
      endDate,
    });
    const allEvents = [];
    for (const row of rows) {
      const events = row.payload?.events;
      if (!Array.isArray(events)) continue;
      for (const e of events) {
        allEvents.push({
          ...e,
          _date: row.date,
        });
      }
    }
    allEvents.sort((a, b) => {
      const ta = a.timestamp != null ? Number(a.timestamp) : 0;
      const tb = b.timestamp != null ? Number(b.timestamp) : 0;
      return tb - ta;
    });
    let filtered = allEvents;
    if (eventType) {
      const typeLower = eventType.toLowerCase();
      filtered = allEvents.filter((e) => {
        const t = (e.type || e.action || e.eventType || e.event_type || e.name || '').toString().toLowerCase();
        return t.includes(typeLower);
      });
    }
    const events = filtered.slice(0, limit);
    const eventTypes = [...new Set(allEvents.flatMap((e) => [
      (e.type || '').toString(),
      (e.action || '').toString(),
      (e.eventType || '').toString(),
      (e.event_type || '').toString(),
      (e.name || '').toString(),
    ].filter(Boolean)))].sort();
    res.json({ events, total: filtered.length, eventTypes });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function getAllKeysFromRows(rows) {
  const set = new Set();
  for (const r of rows) {
    if (r && typeof r === 'object') Object.keys(r).forEach((k) => set.add(k));
  }
  return Array.from(set);
}

// --- Пользователи Jira (обогащение из CSV, при загрузке — полная замена) ---

function parseCSVLine(line) {
  const result = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === '"') {
      let end = i + 1;
      while (end < line.length) {
        if (line[end] === '"' && line[end + 1] !== '"') break;
        if (line[end] === '"' && line[end + 1] === '"') end++;
        end++;
      }
      result.push(line.slice(i + 1, end).replace(/""/g, '"').trim());
      i = end + 1;
      if (line[i] === ',') i++;
    } else {
      const comma = line.indexOf(',', i);
      const end = comma === -1 ? line.length : comma;
      result.push(line.slice(i, end).trim());
      i = comma === -1 ? line.length : comma + 1;
    }
  }
  return result;
}

function parseCSV(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];
  const headers = parseCSVLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    const obj = {};
    headers.forEach((h, j) => {
      obj[h] = values[j] != null ? String(values[j]) : '';
    });
    rows.push(obj);
  }
  return rows;
}

app.get('/api/jira-users', (req, res) => {
  try {
    const users = db.getJiraUsers();
    res.json({ users: users.map((u) => u.data) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/jira-users/upload', requireSettingsAuth, (req, res) => {
  const csv = req.body && req.body.csv ? String(req.body.csv) : '';
  if (!csv.trim()) {
    return res.status(400).json({ error: 'Требуется поле csv в теле запроса (содержимое CSV).' });
  }
  try {
    const rows = parseCSV(csv);
    db.replaceJiraUsers(rows);
    res.json({ ok: true, count: rows.length, message: `Загружено ${rows.length} записей. Предыдущие данные заменены.` });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Ошибка разбора CSV' });
  }
});

// --- Счета Cursor (PDF): парсинг таблицы между Description и Subtotal, сохранение в БД ---

/** Парсинг суммы из строки (например "$1,234.56", "-$116.99") в центы. */
function parseCurrencyToCents(str) {
  if (str == null || str === '') return null;
  const s = String(str).replace(/[$,\s]/g, '').replace(',', '.');
  const n = parseFloat(s);
  return Number.isNaN(n) ? null : Math.round(n * 100);
}

/** Парсинг числа (qty или unit price). */
function parseNum(str) {
  if (str == null || str === '') return null;
  const s = String(str).replace(/\s/g, '').replace(',', '.');
  const n = parseFloat(s);
  return Number.isNaN(n) ? null : n;
}

/** Проверяет, что значение похоже на Qty (0 или небольшое число до 10000). Исключает длинные целые вроде номера токенов. */
function looksLikeQty(num) {
  if (num == null || num < 0) return false;
  if (num >= 0 && num < 10000) return true;
  return false;
}

/** Проверяет, что строка — маркер страницы (например "Page 2 of 2"). */
function isInvoicePageMarker(line) {
  if (!line || typeof line !== 'string') return false;
  return /^Page\s+\d+\s+of\s+\d+\s*$/i.test(line.trim());
}

/** Строка похожа на диапазон дат (Jan 5 – Feb 5, 2026) — не считать её строкой с Qty/Amount. */
function looksLikeDateLine(line) {
  if (!line || typeof line !== 'string') return false;
  const lower = line.trim().toLowerCase();
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  if (months.some((m) => lower.includes(m))) return true;
  if (lower.includes('2026') || lower.includes('2025')) return true;
  return false;
}

/** Удаляет из текста маркеры страниц (Page N of M). */
function stripInvoicePageMarker(desc) {
  if (!desc || typeof desc !== 'string') return desc;
  return desc.replace(/\bPage\s+\d+\s+of\s+\d+\b/gi, '').replace(/\s{2,}/g, ' ').trim() || null;
}

/** Убирает из начала описания слова заголовков таблицы счёта (Description, Qty, Unit price, Tax, Amount и их склейки в PDF). Unit price может быть пустым. */
function stripInvoiceTableHeaderPrefix(desc) {
  if (!desc || typeof desc !== 'string') return desc;
  let s = desc.trim();
  const headerPatterns = [
    /^Description\s*Qty\s*Unit\s*price\s*Tax\s*Amount\s*/i,
    /^Description\s*Qty\s*Unit\s*price\s*Amount\s*/i,
    /^Description\s*Qty\s*Tax\s*Amount\s*/i,
    /^Unit\s*price\s*Tax\s*Amount\s*/i,
    /^Unit\s*price\s*Amount\s*/i,
    /^Unit priceAmount\s*/i,
    /^Unit\s*price\s*Amount/i,
    /^Qty\s*Unit\s*price\s*Tax\s*Amount\s*/i,
    /^Qty\s*Unit\s*price\s*Amount\s*/i,
    /^Qty\s*Tax\s*Amount\s*/i,
    /^Description\s*/i,
    /^Qty\s*/i,
    /^Unit\s*price\s*/i,
    /^Tax\s*/i,
    /^Amount\s*/i,
  ];
  let changed = true;
  while (changed) {
    changed = false;
    for (const re of headerPatterns) {
      const t = s.replace(re, '');
      if (t !== s) {
        s = t.trim();
        changed = true;
        break;
      }
    }
  }
  return s || null;
}

/** Регулярка: тройка Qty$Unit$Amount или четвёрка Qty$Unit$Tax$Amount (Tax в %). Четвёртая группа опциональна. */
const RE_QTY_UNIT_AMOUNT_NO_SPACE = /\)?(\d+)\$([\d,.]+)\$([\d,.]+)(?:\$([\d,.]+))?/g;
/** Ищет в конце строки три или четыре числа: Qty, Unit price, [Tax %], Amount.
 * Возвращает { qtyVal, unitVal, taxPct, amountCents, descEndIndex } или null. */
function parseQtyUnitAmountAtEnd(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const tokens = trimmed.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length >= 4) {
    const amountCents = parseCurrencyToCents(tokens[tokens.length - 1]);
    const taxPct = parseNum(tokens[tokens.length - 2]);
    const unitVal = parseNum(tokens[tokens.length - 3]);
    const qtyVal = parseNum(tokens[tokens.length - 4]);
    if (amountCents != null && unitVal != null && qtyVal != null && looksLikeQty(qtyVal) && taxPct != null && taxPct >= 0 && taxPct <= 100) {
      const suffix = tokens.slice(-4).join(' ');
      return { qtyVal, unitVal, taxPct, amountCents, descEndIndex: Math.max(0, trimmed.length - suffix.length) };
    }
  }
  if (tokens.length >= 3) {
    const last = tokens[tokens.length - 1];
    const mid = parseNum(tokens[tokens.length - 2]);
    const qtyVal = parseNum(tokens[tokens.length - 3]);
    const amountCents = parseCurrencyToCents(last);
    if (amountCents != null && qtyVal != null && looksLikeQty(qtyVal)) {
      const suffix = tokens.slice(-3).join(' ');
      const descEndIndex = Math.max(0, trimmed.length - suffix.length);
      if (mid != null && mid >= 0 && mid <= 100) {
        return { qtyVal, unitVal: null, taxPct: mid, amountCents, descEndIndex };
      }
      if (mid != null) {
        return { qtyVal, unitVal: mid, taxPct: null, amountCents, descEndIndex };
      }
    }
  }
  const fourMatch = trimmed.match(/(\d+)\$([\d,.]+)\$([\d,.]+)\$([\d,.]+)\s*$/);
  if (fourMatch) {
    const qtyVal = parseNum(fourMatch[1]);
    const unitVal = parseNum(fourMatch[2]);
    const taxPct = parseNum(fourMatch[3]);
    const amountCents = parseCurrencyToCents(fourMatch[4]);
    if (qtyVal != null && unitVal != null && amountCents != null && looksLikeQty(qtyVal) && taxPct != null && taxPct >= 0 && taxPct <= 100) {
      return { qtyVal, unitVal, taxPct, amountCents, descEndIndex: trimmed.length - fourMatch[0].length };
    }
  }
  const noSpaceMatch = trimmed.match(/(\d+)\$([\d,.]+)\$([\d,.]+)\s*$/);
  if (noSpaceMatch) {
    const qtyVal = parseNum(noSpaceMatch[1]);
    const unitVal = parseNum(noSpaceMatch[2]);
    const amountCents = parseCurrencyToCents(noSpaceMatch[3]);
    if (qtyVal != null && unitVal != null && amountCents != null && looksLikeQty(qtyVal)) {
      return { qtyVal, unitVal, taxPct: null, amountCents, descEndIndex: trimmed.length - noSpaceMatch[0].length };
    }
  }
  const withParenMatch = trimmed.match(/\)(\d+)\$([\d,.]+)\$([\d,.]+)(?:\$([\d,.]+))?\s*$/);
  if (withParenMatch) {
    const qtyVal = parseNum(withParenMatch[1]);
    const unitVal = parseNum(withParenMatch[2]);
    const hasTax = withParenMatch[4] != null && withParenMatch[4].length > 0;
    const taxPct = hasTax ? parseNum(withParenMatch[3]) : null;
    const amountCents = hasTax ? parseCurrencyToCents(withParenMatch[4]) : parseCurrencyToCents(withParenMatch[3]);
    if (qtyVal != null && unitVal != null && amountCents != null && looksLikeQty(qtyVal)) {
      if (!hasTax || (taxPct != null && taxPct >= 0 && taxPct <= 100)) {
        return { qtyVal, unitVal, taxPct: hasTax ? taxPct : null, amountCents, descEndIndex: trimmed.length - withParenMatch[0].length };
      }
    }
  }
  const qtyTaxAmountMatch = trimmed.match(/(\d+)\s*(\d+)%?\s*\$?\s*(-?\$?[\d,.]+)\s*$/);
  if (qtyTaxAmountMatch) {
    const qtyVal = parseNum(qtyTaxAmountMatch[1]);
    const taxPct = parseNum(qtyTaxAmountMatch[2]);
    const amountCents = parseCurrencyToCents(qtyTaxAmountMatch[3]);
    if (qtyVal != null && amountCents != null && looksLikeQty(qtyVal) && taxPct != null && taxPct >= 0 && taxPct <= 100) {
      return { qtyVal, unitVal: null, taxPct, amountCents, descEndIndex: trimmed.length - qtyTaxAmountMatch[0].length };
    }
  }
  const qtyTaxAmountConcatenated = trimmed.match(/(\d+)(\d+)%\$(-?\$?[\d,.]+)\s*$/);
  if (qtyTaxAmountConcatenated) {
    const qtyVal = parseNum(qtyTaxAmountConcatenated[1]);
    const taxPct = parseNum(qtyTaxAmountConcatenated[2]);
    const amountCents = parseCurrencyToCents(qtyTaxAmountConcatenated[3]);
    if (qtyVal != null && amountCents != null && looksLikeQty(qtyVal) && taxPct != null && taxPct >= 0 && taxPct <= 100) {
      return { qtyVal, unitVal: null, taxPct, amountCents, descEndIndex: trimmed.length - qtyTaxAmountConcatenated[0].length };
    }
  }
  return null;
}

/** Находит в строке все вхождения паттерна Qty$Unit$Amount, Qty$Unit$Tax$Amount или Qty Tax% Amount (без Unit price). Возвращает массив { index, desc, qtyVal, unitVal, taxPct, amountCents }. */
function findAllQtyUnitAmountInLine(line) {
  const matches = [];
  const re = new RegExp(RE_QTY_UNIT_AMOUNT_NO_SPACE.source, 'g');
  let match;
  while ((match = re.exec(line)) !== null) {
    const qtyVal = parseNum(match[1]);
    const unitVal = parseNum(match[2]);
    const hasTax = match[4] != null && match[4].length > 0;
    const taxPct = hasTax ? parseNum(match[3]) : null;
    const amountCents = hasTax ? parseCurrencyToCents(match[4]) : parseCurrencyToCents(match[3]);
    if (qtyVal != null && unitVal != null && amountCents != null && looksLikeQty(qtyVal)) {
      if (!hasTax || (taxPct != null && taxPct >= 0 && taxPct <= 100)) {
        matches.push({ index: match.index, len: match[0].length, qtyVal, unitVal, taxPct: hasTax ? taxPct : null, amountCents });
      }
    }
  }
  const reQtyTax = /(\d+)\s*(\d+)%?\s*\$?(-?[\d,.]+)/g;
  while ((match = reQtyTax.exec(line)) !== null) {
    const qtyVal = parseNum(match[1]);
    const taxPct = parseNum(match[2]);
    const amountCents = parseCurrencyToCents(match[3]);
    if (qtyVal != null && amountCents != null && looksLikeQty(qtyVal) && taxPct != null && taxPct >= 0 && taxPct <= 100) {
      const overlapping = matches.some((m) => match.index < m.index + m.len && match.index + match[0].length > m.index);
      if (!overlapping) matches.push({ index: match.index, len: match[0].length, qtyVal, unitVal: null, taxPct, amountCents });
    }
  }
  const reQtyTaxConcatenated = /(\d+)(\d+)%\$(-?\$?[\d,.]+)/g;
  while ((match = reQtyTaxConcatenated.exec(line)) !== null) {
    const qtyVal = parseNum(match[1]);
    const taxPct = parseNum(match[2]);
    const amountCents = parseCurrencyToCents(match[3]);
    if (qtyVal != null && amountCents != null && looksLikeQty(qtyVal) && taxPct != null && taxPct >= 0 && taxPct <= 100) {
      const overlapping = matches.some((m) => match.index < m.index + m.len && match.index + match[0].length > m.index);
      if (!overlapping) matches.push({ index: match.index, len: match[0].length, qtyVal, unitVal: null, taxPct, amountCents });
    }
  }
  matches.sort((a, b) => a.index - b.index);
  let lastEnd = 0;
  return matches.map((m) => {
    const desc = line.slice(lastEnd, m.index).trim();
    lastEnd = m.index + m.len;
    return { index: m.index, desc, qtyVal: m.qtyVal, unitVal: m.unitVal, taxPct: m.taxPct, amountCents: m.amountCents };
  });
}

/** Извлечь из текста PDF таблицу: строки между заголовком с "Description" и строкой "Subtotal".
 * Новая позиция начинается, когда в строке появляется Qty в конце (три значения: Qty, Unit price, Amount).
 * Поддерживаются форматы с пробелами и без: "1 1.43 1.43" и ")1$1.43$1.43". */
function extractInvoiceTableFromText(text) {
  if (typeof text !== 'string') return [];
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  let headerIdx = -1;
  let subtotalIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLowerCase();
    if (headerIdx < 0 && lower.includes('description')) headerIdx = i;
    if (lower.includes('subtotal')) {
      subtotalIdx = i;
      break;
    }
  }
  if (headerIdx < 0 || subtotalIdx < 0 || subtotalIdx <= headerIdx + 1) {
    return [];
  }
  const bodyLines = lines.slice(headerIdx + 1, subtotalIdx).filter((l) => l.length > 0);
  const rows = [];
  let pendingDescriptionLines = [];
  let rowIndex = 0;

  function cleanDescription(desc) {
    return stripInvoicePageMarker(stripInvoiceTableHeaderPrefix(desc) || '') || null;
  }

  function pendingHasDateLine() {
    return pendingDescriptionLines.some((l) => looksLikeDateLine(l));
  }

  for (let i = 0; i < bodyLines.length; i++) {
    const line = bodyLines[i];
    if (isInvoicePageMarker(line)) continue;
    if (looksLikeDateLine(line)) {
      pendingDescriptionLines.push(line);
      continue;
    }
    const multi = findAllQtyUnitAmountInLine(line);
    if (multi.length > 1) {
      const skipAsDateRow = multi.some((m) => m.amountCents != null && m.amountCents > 0 && m.amountCents < 1000) && pendingHasDateLine();
      if (skipAsDateRow) {
        pendingDescriptionLines.push(line);
        continue;
      }
      for (let k = 0; k < multi.length; k++) {
        const m = multi[k];
        const fullDescription = k === 0 && pendingDescriptionLines.length > 0
          ? (pendingDescriptionLines.join(' ') + (m.desc ? ' ' + m.desc : '')).trim()
          : (m.desc || null);
        rows.push({
          row_index: rowIndex++,
          description: cleanDescription(fullDescription),
          quantity: m.qtyVal,
          unit_price_cents: m.unitVal != null ? Math.round(m.unitVal * 100) : null,
          tax_pct: m.taxPct,
          amount_cents: m.amountCents,
          raw_columns: m.taxPct != null ? [m.qtyVal, m.unitVal, m.taxPct, m.amountCents] : [m.qtyVal, m.unitVal, m.amountCents],
        });
      }
      pendingDescriptionLines = [];
    } else if (multi.length === 1) {
      const m = multi[0];
      if (m.amountCents != null && m.amountCents > 0 && m.amountCents < 1000 && pendingHasDateLine()) {
        pendingDescriptionLines.push(line);
        continue;
      }
      const fullDescription = pendingDescriptionLines.length > 0
        ? (pendingDescriptionLines.join(' ') + (m.desc ? ' ' + m.desc : '')).trim()
        : (m.desc || null);
      rows.push({
        row_index: rowIndex++,
        description: cleanDescription(fullDescription),
        quantity: m.qtyVal,
        unit_price_cents: m.unitVal != null ? Math.round(m.unitVal * 100) : null,
        tax_pct: m.taxPct,
        amount_cents: m.amountCents,
        raw_columns: m.taxPct != null ? [m.qtyVal, m.unitVal, m.taxPct, m.amountCents] : [m.qtyVal, m.unitVal, m.amountCents],
      });
      pendingDescriptionLines = [];
    } else {
      const parsed = parseQtyUnitAmountAtEnd(line);
      if (parsed) {
        if (parsed.amountCents != null && parsed.amountCents > 0 && parsed.amountCents < 1000 && pendingHasDateLine()) {
          pendingDescriptionLines.push(line);
          continue;
        }
        const descOnLine = line.slice(0, parsed.descEndIndex).trim();
        const fullDescription = pendingDescriptionLines.length > 0
          ? (pendingDescriptionLines.join(' ') + (descOnLine ? ' ' + descOnLine : '')).trim()
          : (descOnLine || null);
        rows.push({
          row_index: rowIndex++,
          description: cleanDescription(fullDescription),
          quantity: parsed.qtyVal,
          unit_price_cents: parsed.unitVal != null ? Math.round(parsed.unitVal * 100) : null,
          tax_pct: parsed.taxPct,
          amount_cents: parsed.amountCents,
          raw_columns: parsed.taxPct != null ? [parsed.qtyVal, parsed.unitVal, parsed.taxPct, parsed.amountCents] : [parsed.qtyVal, parsed.unitVal, parsed.amountCents],
        });
        pendingDescriptionLines = [];
      } else {
        pendingDescriptionLines.push(line);
      }
    }
  }
  if (pendingDescriptionLines.length > 0) {
    rows.push({
      row_index: rowIndex++,
      description: cleanDescription(pendingDescriptionLines.join(' ').trim()),
      quantity: null,
      unit_price_cents: null,
      tax_pct: null,
      amount_cents: null,
      raw_columns: pendingDescriptionLines,
    });
  }
  return rows;
}

/** Парсинг PDF-буфера: сначала таблица по структуре (координаты), при неудаче — по тексту. */
async function parseCursorInvoicePdf(buffer) {
  try {
    const rows = await invoicePdfParser.parseCursorInvoicePdfFromStructure(buffer);
    if (rows && rows.length > 0) return rows;
  } catch (_) {}
  const data = await pdfParse(buffer);
  const text = data.text || '';
  return extractInvoiceTableFromText(text);
}

const uploadPdf = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const isPdf = file.mimetype === 'application/pdf' || (file.originalname && String(file.originalname).toLowerCase().endsWith('.pdf'));
    if (isPdf) {
      cb(null, true);
    } else {
      cb(new Error('Разрешены только файлы PDF'), false);
    }
  },
});

app.post('/api/invoices/upload', requireSettingsAuth, uploadPdf.single('pdf'), async (req, res) => {
  if (!req.file || !req.file.buffer) {
    return res.status(400).json({ error: 'Загрузите файл PDF (поле pdf).' });
  }
  try {
    const fileHash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
    const existing = db.getCursorInvoiceByFileHash(fileHash);
    if (existing) {
      return res.status(409).json({
        error: 'Этот счёт уже был загружен.',
        alreadyUploaded: true,
        existing_invoice: { id: existing.id, filename: existing.filename, parsed_at: existing.parsed_at },
      });
    }
    const rows = await parseCursorInvoicePdf(req.file.buffer);
    const filename = req.file.originalname || 'invoice.pdf';
    const invoiceId = db.insertCursorInvoice(filename, null, fileHash);
    rows.forEach((r) => {
      db.insertCursorInvoiceItem(invoiceId, r.row_index, r.description, r.amount_cents, r.raw_columns, r.quantity, r.unit_price_cents, r.tax_pct);
    });
    res.json({ ok: true, invoice_id: invoiceId, filename, items_count: rows.length });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Ошибка парсинга PDF' });
  }
});

app.get('/api/invoices', requireSettingsAuth, (req, res) => {
  try {
    const list = db.getCursorInvoices();
    res.json({ invoices: list });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/invoices/:id/items', requireSettingsAuth, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id) || id < 1) return res.status(400).json({ error: 'Некорректный id.' });
    const invoice = db.getCursorInvoiceById(id);
    if (!invoice) return res.status(404).json({ error: 'Счёт не найден.' });
    const items = db.getCursorInvoiceItems(id);
    res.json({ items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/invoices/:id', requireSettingsAuth, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id) || id < 1) return res.status(400).json({ error: 'Некорректный id.' });
    const deleted = db.deleteCursorInvoice(id);
    if (!deleted) return res.status(404).json({ error: 'Счёт не найден.' });
    res.json({ ok: true, message: 'Счёт удалён.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Обработка ошибок multer (неверный тип файла и т.д.)
app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: 'Файл слишком большой (макс. 15 МБ).' });
  }
  if (err && err.message && (err.message.includes('PDF') || err.message.includes('pdf'))) {
    return res.status(400).json({ error: err.message });
  }
  if (err) {
    console.error('Upload/request error:', err.message || err);
    return res.status(500).json({ error: err.message || 'Ошибка сервера' });
  }
  next();
});

// Периодическая очистка старых записей rate limit
setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of rateLimitMap.entries()) {
    if (now >= bucket.resetAt) rateLimitMap.delete(ip);
  }
}, 60000);

const PORT = process.env.PORT || 3333;
if (process.argv[2] === '--parse-pdf' && process.argv[3]) {
  const pdfPath = path.resolve(process.argv[3]);
  if (!fs.existsSync(pdfPath)) {
    console.error('File not found:', pdfPath);
    process.exit(1);
  }
  const buf = fs.readFileSync(pdfPath);
  parseCursorInvoicePdf(buf)
    .then((rows) => {
      console.log(JSON.stringify(rows, null, 2));
      process.exit(0);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
  return;
}

app.listen(PORT, () => {
  getAuthCredentials(); // создать data/auth.json при первом запуске при необходимости
  console.log('Cursor API Dashboard: http://localhost:' + PORT);
});
