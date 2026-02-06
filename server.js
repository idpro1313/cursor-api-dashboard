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
const db = require('./db');

/** Логирование процесса загрузки по API (для анализа ошибок). Формат: [SYNC] ISO_TIMESTAMP key=value ... */
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const SYNC_LOG_FILE = process.env.SYNC_LOG_FILE || path.join(DATA_DIR, 'sync.log');
const INVOICE_LOGS_DIR = process.env.INVOICE_LOGS_DIR || path.join(DATA_DIR, 'invoice-logs');
let invoiceLogsDirEnsured = false;

/** Настройка автоматического логирования приложения в файл */
const LOG_DIR = path.join(DATA_DIR, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'app.log');

// Создание директории логов
try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
} catch (err) {
  // Игнорируем, если директория уже существует
}

// Функция записи в лог (файл + консоль)
function writeLog(message) {
  const logLine = message + '\n';
  
  // Вывод в консоль (stdout)
  process.stdout.write(logLine);
  
  // Запись в файл (асинхронно, неблокирующая)
  fs.appendFile(LOG_FILE, logLine, function(err) {
    if (err && err.code !== 'ENOENT') {
      // Выводим ошибку записи только в консоль
      process.stderr.write('LOG_WRITE_ERROR: ' + err.message + '\n');
    }
  });
}

// Перехват console.log и console.error для дублирования в файл
const originalConsoleLog = console.log;
const originalConsoleError = console.error;

console.log = function() {
  const message = Array.prototype.slice.call(arguments).join(' ');
  writeLog(message);
};

console.error = function() {
  const message = Array.prototype.slice.call(arguments).join(' ');
  writeLog('[ERROR] ' + message);
};

// Логирование запуска приложения
console.log('[APP] Starting Cursor API Dashboard');
console.log('[APP] Node version: ' + process.version);
console.log('[APP] Data directory: ' + DATA_DIR);
console.log('[APP] Log file: ' + LOG_FILE);

/** Путь к лог-файлу загрузки счёта: имя лога = имя файла счёта + .log (символы \/:*?"<>| заменяются на _). */
function getInvoiceLogPath(filename) {
  if (!filename || typeof filename !== 'string') return path.join(INVOICE_LOGS_DIR, 'unknown.log');
  const safe = filename.replace(/[\s\\/:*?"<>|]/g, '_').trim() || 'invoice';
  return path.join(INVOICE_LOGS_DIR, safe + (safe.endsWith('.log') ? '' : '.log'));
}
/** Текущий лог-файл сессии загрузки (если идёт runSyncToDB). При set все записи syncLog идут в него. */
let currentSyncLogFile = null;
let syncLogDirEnsured = false;

function syncLog(action, fields) {
  fields = fields || {};
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

/** Запись в лог загрузки счёта: отдельный файл на каждый счёт (имя = имя файла счёта + .log), содержимое перезаписывается. */
function invoiceParseLog(entry) {
  const filename = entry.filename || 'invoice.pdf';
  const logFile = getInvoiceLogPath(filename);
  try {
    if (!invoiceLogsDirEnsured) {
      fs.mkdirSync(INVOICE_LOGS_DIR, { recursive: true });
      invoiceLogsDirEnsured = true;
    }
    const ts = new Date().toISOString();
    const lines = [
      '---',
      `[${ts}] filename=${filename} parser=${entry.parser || '?'} rows_count=${entry.rows_count ?? '?'}${entry.error ? ' error=' + entry.error : ''}`,
    ];
    if (entry.error_message) {
      lines.push('error_message: ' + String(entry.error_message).slice(0, 2000));
    }
    if (entry.error_stack) {
      lines.push('error_stack:');
      lines.push(String(entry.error_stack).slice(0, 3000));
    }
    if (entry.parser_output !== undefined && entry.parser_output !== null) {
      const raw = String(entry.parser_output);
      const maxLen = 50000;
      const truncated = raw.length > maxLen ? raw.slice(0, maxLen) + '\n...[обрезано ' + (raw.length - maxLen) + ' символов]' : raw;
      lines.push(`parser_output_length=${raw.length}`);
      lines.push('parser_output:');
      lines.push(truncated);
    } else if (entry.parser === 'opendataloader' && !entry.error_message) {
      lines.push('parser_output: (пусто или ошибка)');
    } else if (entry.parser === 'opendataloader' && entry.error_message) {
      lines.push('parser_output: (не получен из-за ошибки)');
    }
    lines.push('');
    fs.writeFileSync(logFile, lines.join('\n'), 'utf8');
  } catch (e) {
    console.error('[invoice-parse] log write failed:', e.message);
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
const SETTINGS_PAGES_LOWER = ['settings.html', 'invoices.html'];

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
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const parts = forwarded.split(',');
    if (parts.length > 0) return parts[0].trim();
  }
  if (req.socket && req.socket.remoteAddress) return req.socket.remoteAddress;
  return 'unknown';
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
async function cursorFetch(apiKey, apiPath, options, logContext) {
  options = options || {};
  logContext = logContext || {};
  const method = options.method || 'GET';
  const query = options.query || {};
  const body = options.body;
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
  if (ts == null) {
    console.log('[HELPER] toDateKey NULL_INPUT');
    return null;
  }
  let ms;
  if (typeof ts === 'string') {
    const n = Number(ts);
    ms = (ts.trim() !== '' && !isNaN(n)) ? n : new Date(ts).getTime();
  } else {
    ms = Number(ts);
  }
  if (isNaN(ms)) {
    console.log('[HELPER] toDateKey INVALID_MS', JSON.stringify({ ts: ts, tsType: typeof ts }));
    return null;
  }
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

app.get('/api/proxy', requireSettingsAuth, async (req, res) => {
  const ip = getClientIp(req);
  if (!checkRateLimit(ip)) return res.status(429).json({ error: 'Слишком много запросов. Подождите минуту.' });
  const apiKey = getApiKey(req);
  if (!apiKey) return res.status(401).json({ error: 'API key required. Укажите X-API-Key, CURSOR_API_KEY или сохраните ключ в настройках.' });
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

app.post('/api/proxy', requireSettingsAuth, async (req, res) => {
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
  if (!apiKey) return res.status(401).json({ error: 'API key required. Укажите X-API-Key, CURSOR_API_KEY или сохраните ключ в настройках.' });
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
  if (!dateStr || String(dateStr).length < 7) {
    if (!dateStr) console.log('[HELPER] getMonthKey EMPTY_INPUT');
    return null;
  }
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
    const list = membersResp && membersResp.teamMembers ? membersResp.teamMembers : null;
    const teamMembers = Array.isArray(list)
      ? list.map((m) => {
          return {
            email: (m.email || m.userEmail || m.user_email || '').toString().trim().toLowerCase(),
            name: (m.name || m.displayName || m.display_name || m.email || '').toString().trim()
          };
        }).filter((m) => m.email || m.name)
      : [];
    const spendList = spendResp && spendResp.teamMemberSpend ? spendResp.teamMemberSpend : null;
    const teamMemberSpend = Array.isArray(spendList)
      ? spendList.map((s) => {
          const email = (s.userEmail || s.email || s.user_email || '').toString().trim().toLowerCase();
          const cents = Number(s.cents !== undefined && s.cents !== null ? s.cents : (s.totalCents !== undefined && s.totalCents !== null ? s.totalCents : (s.spendCents !== undefined && s.spendCents !== null ? s.spendCents : (s.amount !== undefined && s.amount !== null ? s.amount : 0)))) || 0;
          return { email: email, cents: cents };
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
  const requestId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
  console.log('[ACTIVITY-BY-MONTH] REQUEST_START', JSON.stringify({ requestId: requestId, startDate: req.query.startDate, endDate: req.query.endDate, timestamp: new Date().toISOString() }));
  
  try {
    const startDate = req.query.startDate;
    const endDate = req.query.endDate;
    console.log('[ACTIVITY-BY-MONTH] PARAMS_PARSED', JSON.stringify({ requestId: requestId, startDate: startDate, endDate: endDate }));
    
    if (!startDate || !endDate) {
      console.log('[ACTIVITY-BY-MONTH] PARAMS_MISSING', JSON.stringify({ requestId: requestId }));
      return res.status(400).json({ error: 'Нужны параметры startDate и endDate (YYYY-MM-DD).' });
    }
    console.log('[ACTIVITY-BY-MONTH] FETCHING_JIRA', JSON.stringify({ requestId: requestId }));
    const jiraRows = db.getJiraUsers();
    console.log('[ACTIVITY-BY-MONTH] JIRA_FETCHED', JSON.stringify({ requestId: requestId, jiraRowsCount: jiraRows.length }));
    
    const jiraUsers = jiraRows.map(function(r) { return r.data; });
    console.log('[ACTIVITY-BY-MONTH] JIRA_MAPPED', JSON.stringify({ requestId: requestId, jiraUsersCount: jiraUsers.length }));
    
    const allKeys = jiraUsers.length ? getAllKeysFromRows(jiraUsers) : [];
    console.log('[ACTIVITY-BY-MONTH] ALL_KEYS_EXTRACTED', JSON.stringify({ requestId: requestId, allKeysCount: allKeys.length }));
    
    const emailByMonth = new Map();
    const monthSet = new Set();

    // Daily Usage Data: активные дни, запросы, строки, applies/accepts
    console.log('[ACTIVITY-BY-MONTH] FETCHING_DAILY_USAGE', JSON.stringify({ requestId: requestId, endpoint: '/teams/daily-usage-data', startDate: startDate, endDate: endDate }));
    const dailyRows = db.getAnalytics({
      endpoint: '/teams/daily-usage-data',
      startDate: startDate,
      endDate: endDate
    });
    console.log('[ACTIVITY-BY-MONTH] DAILY_USAGE_FETCHED', JSON.stringify({ requestId: requestId, dailyRowsCount: dailyRows.length }));
    console.log('[ACTIVITY-BY-MONTH] PROCESSING_DAILY_USAGE', JSON.stringify({ requestId: requestId }));
    for (let dailyIdx = 0; dailyIdx < dailyRows.length; dailyIdx++) {
      const row = dailyRows[dailyIdx];
      if (dailyIdx === 0) {
        console.log('[ACTIVITY-BY-MONTH] FIRST_DAILY_ROW', JSON.stringify({ requestId: requestId, rowKeys: Object.keys(row), hasPayload: !!row.payload }));
      }
      const payload = row.payload || {};
      const data = payload.data;
      if (!Array.isArray(data)) {
        if (dailyIdx === 0) console.log('[ACTIVITY-BY-MONTH] DAILY_DATA_NOT_ARRAY', JSON.stringify({ requestId: requestId, dataType: typeof data }));
        continue;
      }
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
          rec = { month: month, lastDate: null, activeDays: 0, requests: 0, linesAdded: 0, linesDeleted: 0, applies: 0, accepts: 0, usageEventsCount: 0, usageCostCents: 0, usageCostByModel: {}, includedEventsCount: 0, includedCostCents: 0, includedCostByModel: {} };
          emailByMonth.set(key, rec);
        }
        rec.activeDays += 1;
        if (dateStr && (!rec.lastDate || dateStr > rec.lastDate)) rec.lastDate = dateStr;
        rec.requests += Number(r.composer_requests !== undefined && r.composer_requests !== null ? r.composer_requests : (r.composerRequests !== undefined && r.composerRequests !== null ? r.composerRequests : 0)) + Number(r.chat_requests !== undefined && r.chat_requests !== null ? r.chat_requests : (r.chatRequests !== undefined && r.chatRequests !== null ? r.chatRequests : 0)) + Number(r.agent_requests !== undefined && r.agent_requests !== null ? r.agent_requests : (r.agentRequests !== undefined && r.agentRequests !== null ? r.agentRequests : 0));
        rec.linesAdded += Number(r.total_lines_added !== undefined && r.total_lines_added !== null ? r.total_lines_added : (r.totalLinesAdded !== undefined && r.totalLinesAdded !== null ? r.totalLinesAdded : 0)) + Number(r.accepted_lines_added !== undefined && r.accepted_lines_added !== null ? r.accepted_lines_added : (r.acceptedLinesAdded !== undefined && r.acceptedLinesAdded !== null ? r.acceptedLinesAdded : 0));
        rec.linesDeleted += Number(r.total_lines_deleted !== undefined && r.total_lines_deleted !== null ? r.total_lines_deleted : (r.totalLinesDeleted !== undefined && r.totalLinesDeleted !== null ? r.totalLinesDeleted : 0)) + Number(r.accepted_lines_deleted !== undefined && r.accepted_lines_deleted !== null ? r.accepted_lines_deleted : (r.acceptedLinesDeleted !== undefined && r.acceptedLinesDeleted !== null ? r.acceptedLinesDeleted : 0));
        rec.applies += Number(r.total_applies !== undefined && r.total_applies !== null ? r.total_applies : (r.totalApplies !== undefined && r.totalApplies !== null ? r.totalApplies : 0));
        rec.accepts += Number(r.total_accepts !== undefined && r.total_accepts !== null ? r.total_accepts : (r.totalAccepts !== undefined && r.totalAccepts !== null ? r.totalAccepts : 0));
      }
    }

    console.log('[ACTIVITY-BY-MONTH] DAILY_USAGE_PROCESSED', JSON.stringify({ requestId: requestId, emailByMonthSize: emailByMonth.size, monthSetSize: monthSet.size }));
    
    // Usage Events Data (Get Usage Events Data): события, стоимость, requestsCosts
    console.log('[ACTIVITY-BY-MONTH] FETCHING_USAGE_EVENTS', JSON.stringify({ requestId: requestId, endpoint: '/teams/filtered-usage-events', startDate: startDate, endDate: endDate }));
    const usageEventsRows = db.getAnalytics({
      endpoint: '/teams/filtered-usage-events',
      startDate: startDate,
      endDate: endDate
    });
    console.log('[ACTIVITY-BY-MONTH] USAGE_EVENTS_FETCHED', JSON.stringify({ requestId: requestId, usageEventsRowsCount: usageEventsRows.length }));
    console.log('[ACTIVITY-BY-MONTH] PROCESSING_USAGE_EVENTS', JSON.stringify({ requestId: requestId }));
    for (let evtIdx = 0; evtIdx < usageEventsRows.length; evtIdx++) {
      const row = usageEventsRows[evtIdx];
      if (evtIdx === 0) {
        console.log('[ACTIVITY-BY-MONTH] FIRST_USAGE_EVENT_ROW', JSON.stringify({ requestId: requestId, rowKeys: Object.keys(row), hasPayload: !!row.payload }));
      }
      const payload = row.payload || {};
      const events = payload.usageEvents;
      if (!Array.isArray(events)) {
        if (evtIdx === 0) console.log('[ACTIVITY-BY-MONTH] EVENTS_NOT_ARRAY', JSON.stringify({ requestId: requestId, eventsType: typeof events }));
        continue;
      }
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
          rec = { month: month, lastDate: null, activeDays: 0, requests: 0, linesAdded: 0, linesDeleted: 0, applies: 0, accepts: 0, usageEventsCount: 0, usageCostCents: 0, usageInputTokens: 0, usageOutputTokens: 0, usageCacheWriteTokens: 0, usageCacheReadTokens: 0, usageTokenCents: 0, usageCostByModel: {}, includedEventsCount: 0, includedCostCents: 0, includedCostByModel: {} };
          emailByMonth.set(key, rec);
        }
        if (dateStr && (!rec.lastDate || dateStr > rec.lastDate)) rec.lastDate = dateStr;
        const tu = e.tokenUsage || {};
        const tokenCents = Number(tu.totalCents !== undefined && tu.totalCents !== null ? tu.totalCents : 0) || 0;
        const cursorFee = Number(e.cursorTokenFee !== undefined && e.cursorTokenFee !== null ? e.cursorTokenFee : 0) || 0;
        rec.usageInputTokens = (rec.usageInputTokens || 0) + Number(tu.inputTokens !== undefined && tu.inputTokens !== null ? tu.inputTokens : 0);
        rec.usageOutputTokens = (rec.usageOutputTokens || 0) + Number(tu.outputTokens !== undefined && tu.outputTokens !== null ? tu.outputTokens : 0);
        rec.usageCacheWriteTokens = (rec.usageCacheWriteTokens || 0) + Number(tu.cacheWriteTokens !== undefined && tu.cacheWriteTokens !== null ? tu.cacheWriteTokens : 0);
        rec.usageCacheReadTokens = (rec.usageCacheReadTokens || 0) + Number(tu.cacheReadTokens !== undefined && tu.cacheReadTokens !== null ? tu.cacheReadTokens : 0);
        rec.usageTokenCents = (rec.usageTokenCents || 0) + tokenCents;
        const modelKey = (e.model || e.modelId || e.modelName || e.providerModelId || '').toString().trim() || 'Другое';
        const kind = (e.kind || e.billingKind || '').toString().toLowerCase();
        const isUsageBased = kind === 'usage-based' || kind === 'usage_based';
        if (isUsageBased) {
          rec.usageEventsCount += 1;
          rec.usageCostCents += tokenCents + cursorFee;
          rec.usageCostByModel[modelKey] = (rec.usageCostByModel[modelKey] || 0) + tokenCents + cursorFee;
        } else {
          rec.includedEventsCount += 1;
          rec.includedCostCents += tokenCents + cursorFee;
          rec.includedCostByModel[modelKey] = (rec.includedCostByModel[modelKey] || 0) + tokenCents + cursorFee;
        }
      }
    }

    console.log('[ACTIVITY-BY-MONTH] USAGE_EVENTS_PROCESSED', JSON.stringify({ requestId: requestId, emailByMonthSize: emailByMonth.size, monthSetSize: monthSet.size }));
    
    console.log('[ACTIVITY-BY-MONTH] CREATING_MONTHS_ARRAY', JSON.stringify({ requestId: requestId }));
    const months = Array.from(monthSet).sort();
    console.log('[ACTIVITY-BY-MONTH] MONTHS_CREATED', JSON.stringify({ requestId: requestId, monthsCount: months.length, months: months }));
    
    const users = [];
    const jiraEmails = new Set();
    // По каждому email: первая и последняя дата по всем строкам Jira, последняя запись для статуса/имени
    console.log('[ACTIVITY-BY-MONTH] BUILDING_JIRA_INFO_MAP', JSON.stringify({ requestId: requestId, jiraRowsCount: jiraRows.length }));
    const emailToJiraInfo = new Map();
    for (let i = 0; i < jiraRows.length; i++) {
      const row = jiraRows[i];
      const id = row.id;
      const jira = row.data;
      const email = getEmailFromJiraRow(jira, allKeys);
      if (!email) continue;
      jiraEmails.add(email);
      const orderKey = getJiraRowOrderKey(jira, id);
      const rowDate = getJiraDateFromRow(jira);
      const existing = emailToJiraInfo.get(email);
      const existingFirstDate = existing && existing.firstDate !== undefined ? existing.firstDate : null;
      const existingLastDate = existing && existing.lastDate !== undefined ? existing.lastDate : null;
      const firstDate = !rowDate ? existingFirstDate : (!existingFirstDate || rowDate < existingFirstDate ? rowDate : existingFirstDate);
      const lastDate = !rowDate ? existingLastDate : (!existingLastDate || rowDate > existingLastDate ? rowDate : existingLastDate);
      if (!existing || orderKey > existing.orderKey) {
        emailToJiraInfo.set(email, { jira: jira, id: id, orderKey: orderKey, firstDate: firstDate, lastDate: lastDate });
      } else {
        const updated = Object.assign({}, existing, { firstDate: firstDate, lastDate: lastDate });
        emailToJiraInfo.set(email, updated);
      }
    }
    console.log('[ACTIVITY-BY-MONTH] JIRA_INFO_MAP_BUILT', JSON.stringify({ requestId: requestId, emailToJiraInfoSize: emailToJiraInfo.size }));
    
    console.log('[ACTIVITY-BY-MONTH] BUILDING_USERS_FROM_JIRA', JSON.stringify({ requestId: requestId }));
    for (const entry of emailToJiraInfo) {
      const email = entry[0];
      const info = entry[1];
      const jira = info.jira;
      const firstDate = info.firstDate;
      const lastDate = info.lastDate;
      const displayName = jira['Пользователь, которому выдан доступ'] || jira['Display Name'] || jira['Username'] || jira['Name'] || email || '—';
      const jiraStatus = getJiraStatusFromRow(jira);
      const jiraProject = getJiraProjectFromRow(jira);
      const monthlyActivity = months.map((month) => {
        const rec = emailByMonth.get(email + '\n' + month);
        const def = { month: month, lastDate: null, activeDays: 0, requests: 0, linesAdded: 0, linesDeleted: 0, applies: 0, accepts: 0, usageEventsCount: 0, usageCostCents: 0, usageInputTokens: 0, usageOutputTokens: 0, usageCacheWriteTokens: 0, usageCacheReadTokens: 0, usageTokenCents: 0, usageCostByModel: {}, includedEventsCount: 0, includedCostCents: 0, includedCostByModel: {} };
        if (!rec) return def;
        const result = Object.assign({}, def, rec);
        result.usageCostByModel = Object.assign({}, def.usageCostByModel, rec.usageCostByModel || {});
        result.includedCostByModel = Object.assign({}, def.includedCostByModel, rec.includedCostByModel || {});
        return result;
      });
      const jiraConnectedAt = firstDate || null;
      const jiraDisconnectedAt = jiraStatus === 'archived' && lastDate ? lastDate : null;
      users.push({ jira: jira, email: email, displayName: String(displayName), jiraStatus: jiraStatus, jiraProject: jiraProject, jiraConnectedAt: jiraConnectedAt, jiraDisconnectedAt: jiraDisconnectedAt, monthlyActivity: monthlyActivity });
    }
    console.log('[ACTIVITY-BY-MONTH] JIRA_USERS_BUILT', JSON.stringify({ requestId: requestId, usersFromJiraCount: users.length }));
    
    console.log('[ACTIVITY-BY-MONTH] FINDING_CURSOR_ONLY_USERS', JSON.stringify({ requestId: requestId }));
    const cursorOnlyEmails = new Set();
    for (const key of emailByMonth.keys()) {
      const email = key.split('\n')[0];
      if (email && !jiraEmails.has(email)) cursorOnlyEmails.add(email);
    }
    for (const email of cursorOnlyEmails) {
      const monthlyActivity = months.map((month) => {
        const rec = emailByMonth.get(email + '\n' + month);
        const def = { month: month, lastDate: null, activeDays: 0, requests: 0, linesAdded: 0, linesDeleted: 0, applies: 0, accepts: 0, usageEventsCount: 0, usageCostCents: 0, usageInputTokens: 0, usageOutputTokens: 0, usageCacheWriteTokens: 0, usageCacheReadTokens: 0, usageTokenCents: 0, usageCostByModel: {}, includedEventsCount: 0, includedCostCents: 0, includedCostByModel: {} };
        if (!rec) return def;
        const result = Object.assign({}, def, rec);
        result.usageCostByModel = Object.assign({}, def.usageCostByModel, rec.usageCostByModel || {});
        result.includedCostByModel = Object.assign({}, def.includedCostByModel, rec.includedCostByModel || {});
        return result;
      });
      users.push({ jira: {}, email: email, displayName: email, jiraStatus: null, jiraProject: null, jiraConnectedAt: null, jiraDisconnectedAt: null, monthlyActivity: monthlyActivity });
    }
    console.log('[ACTIVITY-BY-MONTH] CURSOR_ONLY_USERS_ADDED', JSON.stringify({ requestId: requestId, cursorOnlyEmailsCount: cursorOnlyEmails.size, totalUsersCount: users.length }));

    // lastActivityMonth, lastActivityDate и totalRequestsInPeriod по каждому пользователю
    console.log('[ACTIVITY-BY-MONTH] CALCULATING_USER_STATS', JSON.stringify({ requestId: requestId }));
    const lastMonthInRange = months.length ? months[months.length - 1] : null;
    for (const u of users) {
      let lastActivityMonth = null;
      let lastActivityDate = null;
      let totalRequests = 0;
      for (const a of u.monthlyActivity || []) {
        totalRequests += a.requests || 0;
        if ((a.requests || 0) + (a.usageEventsCount || 0) + (a.includedEventsCount || 0) > 0) {
          lastActivityMonth = a.month;
          const d = a.lastDate || null;
          if (d && (!lastActivityDate || d > lastActivityDate)) lastActivityDate = d;
        }
      }
      u.lastActivityMonth = lastActivityMonth;
      u.lastActivityDate = lastActivityDate;
      u.totalRequestsInPeriod = totalRequests;
    }
    console.log('[ACTIVITY-BY-MONTH] USER_STATS_CALCULATED', JSON.stringify({ requestId: requestId }));

    // Team Members и Spending Data — только из БД не берём; отдельный дашборд /team-snapshot.html запрашивает их через API
    console.log('[ACTIVITY-BY-MONTH] SETTING_TEAM_SPEND', JSON.stringify({ requestId: requestId }));
    for (const u of users) {
      u.teamSpendCents = 0;
    }

    // Активные в Jira, но не используют / редко используют Cursor (после назначения teamSpendCents)
    console.log('[ACTIVITY-BY-MONTH] FILTERING_INACTIVE_USERS', JSON.stringify({ requestId: requestId }));
    const activeJiraButInactiveCursor = users.filter(function(u) {
      if (u.jiraStatus === 'archived' || u.jiraStatus == null) return false;
      const noUse = (u.totalRequestsInPeriod || 0) === 0;
      const noRecentUse = lastMonthInRange && (u.lastActivityMonth == null || u.lastActivityMonth < lastMonthInRange);
      const rarelyUse = (u.totalRequestsInPeriod || 0) > 0 && (u.totalRequestsInPeriod || 0) < 5;
      return noUse || noRecentUse || rarelyUse;
    }).map(function(u) {
      return {
      email: u.email,
      displayName: u.displayName,
      jiraProject: u.jiraProject,
      jiraStatus: u.jiraStatus,
      jiraConnectedAt: u.jiraConnectedAt,
      jiraDisconnectedAt: u.jiraDisconnectedAt,
      lastActivityMonth: u.lastActivityMonth,
      lastActivityDate: u.lastActivityDate,
      totalRequestsInPeriod: u.totalRequestsInPeriod,
      teamSpendCents: u.teamSpendCents
      };
    });
    console.log('[ACTIVITY-BY-MONTH] INACTIVE_USERS_FILTERED', JSON.stringify({ requestId: requestId, inactiveUsersCount: activeJiraButInactiveCursor.length }));

    // Затраты по проекту помесячно (usageCostCents по месяцам)
    console.log('[ACTIVITY-BY-MONTH] CALCULATING_PROJECT_COSTS', JSON.stringify({ requestId: requestId }));
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
    console.log('[ACTIVITY-BY-MONTH] PROJECT_COSTS_CALCULATED', JSON.stringify({ requestId: requestId, projectsCount: Object.keys(projectTotals).length }));

    console.log('[ACTIVITY-BY-MONTH] BUILDING_RESPONSE', JSON.stringify({ requestId: requestId, usersCount: users.length, monthsCount: months.length }));
    const responseData = {
      users: users,
      months: months,
      activeJiraButInactiveCursor: activeJiraButInactiveCursor,
      costByProjectByMonth: costByProjectByMonth,
      projectTotals: projectTotals
    };
    console.log('[ACTIVITY-BY-MONTH] RESPONSE_READY', JSON.stringify({ requestId: requestId }));
    
    res.json(responseData);
    console.log('[ACTIVITY-BY-MONTH] RESPONSE_SENT', JSON.stringify({ requestId: requestId }));
  } catch (e) {
    console.error('[ACTIVITY-BY-MONTH] ERROR', JSON.stringify({ requestId: requestId, errorMessage: e.message, errorStack: e.stack }));
    res.status(500).json({ error: e.message || 'Ошибка сервера', requestId: requestId });
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

// --- Счета Cursor (PDF): парсинг по OpenDataLoader JSON (schema: https://opendataloader.org/docs/json-schema) ---

/** Рекурсивно извлечь текст из элемента OpenDataLoader (paragraph.content, table cell → kids → content). */
function getTextFromOdlElement(el) {
  if (!el) return '';
  if (typeof el.content === 'string') return el.content.trim();
  if (Array.isArray(el.kids)) return el.kids.map(getTextFromOdlElement).filter(Boolean).join(' ').trim();
  return '';
}

const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** Извлечь "Date of issue" из документа OpenDataLoader (строка YYYY-MM-DD или null). */
function extractInvoiceIssueDateFromOdlDoc(doc) {
  if (!doc || !Array.isArray(doc.kids)) return null;
  let fullText = '';
  for (const k of doc.kids) {
    fullText += ' ' + getTextFromOdlElement(k);
  }
  const m = fullText.match(/Date of issue[:\s]+([A-Za-z]+\s+\d{1,2},\s*\d{4})/i);
  if (!m || !m[1]) return null;
  const dateStr = m[1].trim();
  const parts = dateStr.match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/i);
  if (!parts) return null;
  const monthIdx = MONTH_NAMES.indexOf(parts[1].toLowerCase());
  if (monthIdx < 0) return null;
  const month = String(monthIdx + 1).padStart(2, '0');
  const day = String(parseInt(parts[2], 10)).padStart(2, '0');
  const year = parts[3];
  return `${year}-${month}-${day}`;
}

/** Рекурсивно развернуть список (list) и вложенные списки в плоский массив строк. */
function flattenListItemsInto(listElement, lines) {
  if (!listElement || !Array.isArray(listElement['list items'])) return;
  for (const item of listElement['list items']) {
    if (!item) continue;
    const content = typeof item.content === 'string' ? item.content.trim() : getTextFromOdlElement(item);
    if (content && content.length >= 2) lines.push(content);
    if (Array.isArray(item.kids)) {
      for (const c of item.kids) {
        if (c && c.type === 'list' && Array.isArray(c['list items'])) {
          flattenListItemsInto(c, lines);
        } else {
          const t = getTextFromOdlElement(c);
          if (t && t.length >= 2) lines.push(t);
        }
      }
    }
  }
}

/** Собрать плоский список текстовых строк из doc.kids; списки разворачиваются в строки из list items. */
function flattenOdlContentLines(kids) {
  const lines = [];
  if (!Array.isArray(kids)) return lines;
  for (const k of kids) {
    if (!k || k.type === 'image') continue;
    if (k.type === 'footer') continue;
    if (k.type === 'list' && Array.isArray(k['list items'])) {
      flattenListItemsInto(k, lines);
      continue;
    }
    const text = getTextFromOdlElement(k);
    if (!text || text.length < 2) continue;
    if (/^Page\s+\d+\s+of\s+\d+/i.test(text)) continue;
    lines.push(text);
  }
  return lines;
}

/** Собрать строки счёта из параграфов/списков, когда таблица не распознана (как в temp/old). */
function extractInvoiceRowsFromOdlParagraphs(doc) {
  if (!doc || !Array.isArray(doc.kids)) return { rows: [], source: 'paragraphs' };
  const contentLines = flattenOdlContentLines(doc.kids);
  let headerIndex = -1;
  for (let i = 0; i < contentLines.length; i++) {
    const lower = contentLines[i].toLowerCase();
    if (lower.includes('description') && (lower.includes('qty') || lower.includes('amount'))) {
      headerIndex = i;
      break;
    }
  }
  if (headerIndex < 0) return { rows: [], source: 'paragraphs' };
  const afterHeader = contentLines.slice(headerIndex + 1);
  const amountLineRe = /^\s*(\d+)\s+(-?\$[\d,.]+)\s+(-?\$[\d,.]+)\s*$/;
  const amountLineTwoRe = /^\s*(\d+)\s+(-?\$[\d,.]+)\s*$/;
  const amountLineTaxRe = /^\s*(\d+)\s+(\d+)%\s+(-?\$[\d,.]+)\s*$/;
  const amountLineUnitTaxRe = /^\s*(\d+)\s+(-?\$[\d,.]+)\s+(\d+)%\s+(-?\$[\d,.]+)\s*$/;
  const amountAtEndRe = /\s+(\d+)\s+(-?\$[\d,.]+)\s+(-?\$[\d,.]+)\s*$/;
  const amountAtEndTwoRe = /\s+(\d+)\s+(-?\$[\d,.]+)\s*$/;
  const amountTaxAtEndRe = /\s+(\d+)\s+(\d+)%\s+(-?\$[\d,.]+)\s*$/;
  const amountUnitTaxAtEndRe = /\s+(\d+)\s+(-?\$[\d,.]+)\s+(\d+)%\s+(-?\$[\d,.]+)\s*$/;
  const skipRe = /^(Subtotal|Total|Amount\s+due|VAT\s|Applied\s+balance)\s+/i;
  const skipFooterRe = /(?:^|\s)(?:Anysphere|EIN\s+\d|Applied\s+balance|Amount\s+due\s+\$)/i;
  const out = [];
  const pendingDescs = [];
  const cleanDesc = (s) => (s && typeof s === 'string' ? s.replace(/\u0000/g, ' ').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').replace(/\s*[0-9a-f]{8}\)?\s*$/i, '').trim() || null : null);
  const pushRow = (desc, qty, unitCents, taxPct, amountCents) => {
    if (amountCents == null && !desc) return;
    out.push({
      row_index: out.length,
      description: cleanDesc(desc) || null,
      quantity: qty != null && looksLikeQty(qty) ? qty : null,
      unit_price_cents: unitCents != null ? unitCents : null,
      tax_pct: taxPct != null && taxPct >= 0 && taxPct <= 100 ? taxPct : null,
      amount_cents: amountCents,
      raw_columns: taxPct != null ? [qty, unitCents != null ? unitCents / 100 : null, taxPct, amountCents] : [qty, unitCents != null ? unitCents / 100 : null, amountCents],
    });
  };
  for (let line of afterHeader) {
    line = String(line)
      .replace(/\u0000\s*\$/g, '-$')
      .replace(/\u0000/g, ' ')
      .trim();
    if (!line) continue;
    if (skipRe.test(line) || /^\s*\$[\d,.]+(\s+\$[\d,.]+)*\s*$/.test(line)) continue;
    if (/^Subtotal\s+/.test(line) || /Total\s+\$/.test(line) || /VAT\s+-/.test(line)) continue;
    if (/Total\s+excluding\s+tax/i.test(line)) continue;
    if (skipFooterRe.test(line)) continue;
    let m = line.match(amountLineRe);
    let taxPct = null;
    let unitCents = null;
    if (m) {
      unitCents = parseCurrencyToCents(m[2]);
    } else {
      m = line.match(amountLineTaxRe);
      if (m) taxPct = parseNum(m[2]);
    }
    if (!m) {
      m = line.match(amountLineUnitTaxRe);
      if (m) {
        unitCents = parseCurrencyToCents(m[2]);
        taxPct = parseNum(m[3]);
      }
    }
    if (m && m[0].length === line.length) {
      const qty = parseNum(m[1]);
      const amountCents = parseCurrencyToCents(m[m.length - 1]);
      const desc = pendingDescs.length > 0 ? pendingDescs.join(' ').trim() : null;
      pendingDescs.length = 0;
      pushRow(desc, qty, unitCents, taxPct, amountCents);
      continue;
    }
    m = line.match(amountLineTwoRe);
    if (m && m[0].length === line.length) {
      const qty = parseNum(m[1]);
      const amountCents = parseCurrencyToCents(m[2]);
      const desc = pendingDescs.length > 0 ? pendingDescs.join(' ').trim() : null;
      pendingDescs.length = 0;
      const unitCentsTwo = qty && qty > 0 && amountCents != null ? Math.round(amountCents / qty) : null;
      pushRow(desc, qty, unitCentsTwo, null, amountCents);
      continue;
    }
    let endM = line.match(amountAtEndRe);
    if (endM) {
      const inlineDesc = line.slice(0, line.length - endM[0].length).trim();
      const fullDesc = (pendingDescs.length > 0 ? pendingDescs.join(' ').trim() + (inlineDesc ? ' ' + inlineDesc : '') : inlineDesc) || null;
      pendingDescs.length = 0;
      const qty = parseNum(endM[1]);
      const unitCentsEnd = parseCurrencyToCents(endM[2]);
      const amountCents = parseCurrencyToCents(endM[3]);
      pushRow(fullDesc, qty, unitCentsEnd, null, amountCents);
      continue;
    }
    endM = line.match(amountTaxAtEndRe);
    if (endM) {
      const inlineDesc = line.slice(0, line.length - endM[0].length).trim();
      const fullDesc = (pendingDescs.length > 0 ? pendingDescs.join(' ').trim() + (inlineDesc ? ' ' + inlineDesc : '') : inlineDesc) || null;
      pendingDescs.length = 0;
      const qty = parseNum(endM[1]);
      const taxPctEnd = parseNum(endM[2]);
      const amountCents = parseCurrencyToCents(endM[3]);
      pushRow(fullDesc, qty, null, taxPctEnd, amountCents);
      continue;
    }
    endM = line.match(amountUnitTaxAtEndRe);
    if (endM) {
      const inlineDesc = line.slice(0, line.length - endM[0].length).trim();
      const fullDesc = (pendingDescs.length > 0 ? pendingDescs.join(' ').trim() + (inlineDesc ? ' ' + inlineDesc : '') : inlineDesc) || null;
      pendingDescs.length = 0;
      const qty = parseNum(endM[1]);
      const unitCentsEnd = parseCurrencyToCents(endM[2]);
      const taxPctEnd = parseNum(endM[3]);
      const amountCents = parseCurrencyToCents(endM[4]);
      pushRow(fullDesc, qty, unitCentsEnd, taxPctEnd, amountCents);
      continue;
    }
    endM = line.match(amountAtEndTwoRe);
    if (endM) {
      const inlineDesc = line.slice(0, line.length - endM[0].length).trim();
      const fullDesc = (pendingDescs.length > 0 ? pendingDescs.join(' ').trim() + (inlineDesc ? ' ' + inlineDesc : '') : inlineDesc) || null;
      if (fullDesc) {
        pendingDescs.length = 0;
        const qty = parseNum(endM[1]);
        const amountCents = parseCurrencyToCents(endM[2]);
        pushRow(fullDesc, qty, null, null, amountCents);
        continue;
      }
    }
    pendingDescs.push(line);
  }
  return { rows: out, source: 'paragraphs' };
}

/** Найти таблицу счёта в документе OpenDataLoader. Возвращает { table, headerTexts, rowCount } или null. */
function findInvoiceTableInOdlDoc(doc) {
  function walk(el) {
    if (!el) return null;
    if (el.type === 'table' && Array.isArray(el.rows) && el.rows.length > 1) {
      const headerCells = el.rows[0].cells || [];
      const headerTexts = headerCells.map((c) => getTextFromOdlElement(c));
      const headerText = headerTexts.join(' ').toLowerCase();
      if (headerText.includes('description') && (headerText.includes('qty') || headerText.includes('amount'))) {
        return { table: el, headerTexts, rowCount: el.rows.length };
      }
    }
    if (Array.isArray(el.kids)) {
      for (const k of el.kids) {
        const found = walk(k);
        if (found) return found;
      }
    }
    return null;
  }
  if (doc && Array.isArray(doc.kids)) {
    for (const k of doc.kids) {
      const found = walk(k);
      if (found) return found;
    }
  }
  return null;
}

/** Извлечь строки счёта из таблицы OpenDataLoader. Возвращает { rows, columnIndices }. */
function extractInvoiceRowsFromOdlTable(table) {
  const tableRows = table && table.rows ? table.rows : (Array.isArray(table) ? table : null);
  if (!Array.isArray(tableRows)) return { rows: [], columnIndices: null };
  const rows = tableRows;
  if (rows.length < 2) return { rows: [], columnIndices: null };
  const headerRow = rows[0];
  const headerCells = headerRow.cells || [];
  const colCount = headerCells.length;
  const headerTexts = headerCells.map((c) => getTextFromOdlElement(c).toLowerCase());
  let idxDesc = -1; let idxQty = -1; let idxUnit = -1; let idxTax = -1; let idxAmount = -1;
  for (let i = 0; i < headerTexts.length; i++) {
    const h = headerTexts[i];
    if (h.includes('description')) idxDesc = i;
    if (h.includes('qty')) idxQty = i;
    if (h.includes('unit') || (h.includes('price') && !h.includes('unit'))) idxUnit = i;
    if (h === 'tax' || h.includes('tax')) idxTax = i;
    if (h.includes('amount')) idxAmount = i;
  }
  if (idxAmount < 0) idxAmount = colCount - 1;
  const columnIndices = { description: idxDesc, qty: idxQty, unit_price: idxUnit, tax: idxTax, amount: idxAmount };
  if (idxDesc < 0 || idxQty < 0 || idxAmount < 0) return { rows: [], columnIndices };

  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const cells = row.cells || [];
    const getCell = (idx) => (idx >= 0 && idx < cells.length ? getTextFromOdlElement(cells[idx]) : '');
    const rawDesc = getCell(idxDesc);
    const desc = rawDesc ? rawDesc.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim() || null : null;
    const qtyStr = getCell(idxQty).trim();
    const unitStr = idxUnit >= 0 ? getCell(idxUnit).trim() : '';
    const taxStr = idxTax >= 0 ? getCell(idxTax).trim() : '';
    const amountStr = getCell(idxAmount).trim();

    const qtyVal = parseNum(qtyStr);
    const unitVal = unitStr ? parseNum(unitStr) : null;
    const taxPct = taxStr ? parseNum(taxStr.replace(/%/g, '')) : null;
    const amountCents = amountStr ? parseCurrencyToCents(amountStr) : null;

    if (amountCents == null && !desc) continue;
    const hasValidQty = qtyVal != null && looksLikeQty(qtyVal);
    const taxVal = taxPct != null && taxPct >= 0 && taxPct <= 100 ? taxPct : null;
    out.push({
      row_index: out.length,
      description: desc || null,
      quantity: hasValidQty ? qtyVal : null,
      unit_price_cents: unitVal != null ? Math.round(unitVal * 100) : null,
      tax_pct: taxVal,
      amount_cents: amountCents,
      raw_columns: idxTax >= 0 ? [qtyVal, unitVal, taxVal, amountCents] : [qtyVal, unitVal, amountCents],
    });
  }
  return { rows: out, columnIndices };
}

/** Парсинг суммы из строки (например "$1,234.56", "-$116.99", "\u0000$450.83" — отрицательная в PDF) в центы. */
function parseCurrencyToCents(str) {
  if (str == null || str === '') return null;
  let s = String(str).replace(/\u0000\s*\$/g, '-$').replace(/\u0000/g, ' ');
  s = s.replace(/[$\s]/g, '').replace(/,/g, '');
  const n = parseFloat(s);
  return Number.isNaN(n) ? null : Math.round(n * 100);
}

/** Парсинг числа (qty или unit price). Поддержка формата с $ (например $20.00 из pypdf). */
function parseNum(str) {
  if (str == null || str === '') return null;
  const s = String(str).replace(/[$\s]/g, '').replace(/,/g, '');
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
  const trimmed = line.trim();
  // Шаблон: "Mon DD – Mon DD, YYYY" или "Mon DD, YYYY – Mon DD, YYYY" (с разными тире)
  if (/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}(?:,\s*\d{4})?\s*[\u2013\u2014\-]\s*(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s*\d{4}\b/i.test(trimmed)) return true;
  // Дата вида "January 6, 2026"
  if (/\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s*\d{4}\b/i.test(trimmed)) return true;
  // Дата вида "Date of issue"
  if (/date\s+of\s+issue/i.test(trimmed)) return true;
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
    const midToken = tokens[tokens.length - 2];
    const mid = parseNum(midToken);
    const qtyVal = parseNum(tokens[tokens.length - 3]);
    const amountCents = parseCurrencyToCents(last);
    if (amountCents != null && qtyVal != null && looksLikeQty(qtyVal)) {
      const suffix = tokens.slice(-3).join(' ');
      const descEndIndex = Math.max(0, trimmed.length - suffix.length);
      const looksLikeUnitPrice = midToken && /[.$]/.test(String(midToken));
      if (mid != null && looksLikeUnitPrice) {
        return { qtyVal, unitVal: mid, taxPct: null, amountCents, descEndIndex };
      }
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

/** Нормализация текста от pypdf: преобразует \u0000$ в -$ (отрицательные суммы), склеивает суммы, разорванные переносом строки (например "$1,\n120.00" → "$1,120.00"). */
function normalizePypdfInvoiceText(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/\u0000\s*\$/g, '-$')
    .replace(/\u0000/g, '')
    .replace(/(\$\d+),\s*\r?\n\s*(\d+\.\d{2})\b/g, '$1,$2')
    .replace(/(\$\d+),\s*\r?\n\s*(\d+)\b/g, '$1,$2');
}

/** Парсинг таблицы в формате pypdf.
 * Заголовок: "Description Qty Unit price Amount" или "Description Qty Unit price Tax Amount".
 * Для каждой позиции — строки описания, затем одна строка данных:
 *   без Tax: "Qty Unit_price Amount" (например "0 $20.00 $0.00");
 *   с Tax:   "Qty Tax% Amount" (например "33 21% $113.55", Unit price в строке нет).
 * Тело таблицы заканчивается на строке с "Subtotal" (после неё может идти сумма). */
function extractInvoiceTableFromPypdfText(text) {
  if (typeof text !== 'string') return [];
  const normalized = normalizePypdfInvoiceText(text);
  const lines = normalized.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);

  let headerIdx = -1;
  let subtotalIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLowerCase();
    if (headerIdx < 0 && lower.includes('description') && (lower.includes('qty') || lower.includes('amount'))) headerIdx = i;
    if (lower.includes('subtotal')) {
      subtotalIdx = i;
      break;
    }
  }
  if (headerIdx < 0 || subtotalIdx < 0 || subtotalIdx <= headerIdx + 1) return [];

  const bodyLines = lines.slice(headerIdx + 1, subtotalIdx).filter((l) => l.length > 0);
  const rows = [];
  let rowIndex = 0;
  let descriptionLines = [];

  // Нормализация неразрывных/узких пробелов (pypdf может выдать \u00A0, \u202F и т.д.), иначе строка не матчится
  const norm = (s) => (typeof s === 'string' ? s.replace(/\u00A0|\u202F|\u2009|\u2007/g, ' ') : s);

  // Строка данных с Tax: "Qty Tax% Amount" (например "33 21% $113.55" или "34 21%  $116.99")
  const dataLineWithTaxRe = /^\s*(\d+)\s+(\d+)\s*%?\s*[\s\u00A0\u202F\u2009]*(\$?[\d,.]+)\s*$/;
  // Строка данных без Tax: "Qty Unit_price Amount" (например "0 $20.00 $0.00")
  const dataLineNoTaxRe = /^\s*(\d+)\s+(\$?[\d,.]+)\s+(\$?[\d,.]+)\s*$/;

  for (let i = 0; i < bodyLines.length; i++) {
    const line = norm(bodyLines[i]);
    let matched = false;

    const taxMatch = line.match(dataLineWithTaxRe);
    if (taxMatch) {
      const qtyVal = parseNum(taxMatch[1]);
      const taxPct = parseNum(taxMatch[2]);
      const amountCents = parseCurrencyToCents(taxMatch[3]);
      if (qtyVal != null && looksLikeQty(qtyVal) && taxPct != null && taxPct >= 0 && taxPct <= 100 && amountCents != null) {
        const desc = descriptionLines.filter(Boolean).join(' ').trim();
        const cleaned = stripInvoicePageMarker(stripInvoiceTableHeaderPrefix(desc) || '') || null;
        rows.push({
          row_index: rowIndex++,
          description: cleaned,
          quantity: qtyVal,
          unit_price_cents: null,
          tax_pct: taxPct,
          amount_cents: amountCents,
          raw_columns: [qtyVal, taxPct, amountCents],
        });
        descriptionLines = [];
        matched = true;
      }
    }

    if (!matched) {
      const noTaxMatch = line.match(dataLineNoTaxRe);
      if (noTaxMatch) {
        const qtyVal = parseNum(noTaxMatch[1]);
        const unitVal = parseNum(noTaxMatch[2]);
        const amountCents = parseCurrencyToCents(noTaxMatch[3]);
        if (qtyVal != null && looksLikeQty(qtyVal) && unitVal != null && amountCents != null) {
          const desc = descriptionLines.filter(Boolean).join(' ').trim();
          const cleaned = stripInvoicePageMarker(stripInvoiceTableHeaderPrefix(desc) || '') || null;
          rows.push({
            row_index: rowIndex++,
            description: cleaned,
            quantity: qtyVal,
            unit_price_cents: unitVal != null ? Math.round(unitVal * 100) : null,
            tax_pct: null,
            amount_cents: amountCents,
            raw_columns: [qtyVal, unitVal, amountCents],
          });
          descriptionLines = [];
          matched = true;
        }
      }
    }

    if (!matched) {
      descriptionLines.push(line);
    }
  }
  return rows;
}

/** Извлечь из текста PDF таблицу: строки между заголовком с "Description" и строкой "Subtotal".
 * Новая позиция начинается, когда в строке появляется Qty в конце (три значения: Qty, Unit price, Amount).
 * Поддерживаются форматы с пробелами и без: "1 1.43 1.43" и ")1$1.43$1.43". */
function extractInvoiceTableFromText(text) {
  if (typeof text !== 'string') return [];
  const normalized = normalizePypdfInvoiceText(text);
  const lines = normalized.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
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
    const desc = cleanDescription(pendingDescriptionLines.join(' ').trim());
    const hasRealContent = desc && desc.replace(/\s/g, '').length > 0 && !/^[\s\uFFFD\u200B-\u200D\uFEFF]*$/u.test(desc);
    if (hasRealContent) {
      rows.push({
        row_index: rowIndex++,
        description: desc,
        quantity: null,
        unit_price_cents: null,
        tax_pct: null,
        amount_cents: null,
        raw_columns: pendingDescriptionLines,
      });
    }
  }
  return rows;
}

/** Парсинг PDF-буфера через OpenDataLoader PDF.
 * API: https://opendataloader.org/docs/quick-start-nodejs
 * JSON-схема: https://opendataloader.org/docs/json-schema
 * Требуется Java 11+ в PATH. */
async function parseCursorInvoicePdf(buffer) {
  const useOpenDataLoader = process.env.USE_OPENDATALOADER !== '0' && process.env.USE_OPENDATALOADER !== 'false';
  if (!useOpenDataLoader) {
    return { rows: [], parser: null, pypdfText: null, error: 'OPENDATALOADER_DISABLED' };
  }
  try {
    // Задаём JAVA_HOME, если не задан (иначе @opendataloader/pdf может передать undefined в path → "path argument... Received undefined")
    if (!process.env.JAVA_HOME || typeof process.env.JAVA_HOME !== 'string' || !process.env.JAVA_HOME.trim()) {
      if (process.platform === 'linux') {
        const candidates = ['/usr/lib/jvm/java-17-openjdk', '/usr/lib/jvm/java-11-openjdk', '/usr/lib/jvm/default-jvm'];
        for (const dir of candidates) {
          try {
            if (fs.existsSync(path.join(dir, 'bin', 'java'))) {
              process.env.JAVA_HOME = dir;
              process.env.PATH = path.join(dir, 'bin') + path.delimiter + (process.env.PATH || '');
              break;
            }
          } catch (_) {}
        }
      } else if (process.platform === 'win32') {
        const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
        const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
        const candidates = [];
        try {
          const pf = path.join(programFiles, 'Java');
          if (fs.existsSync(pf)) {
            const entries = fs.readdirSync(pf, { withFileTypes: true });
            for (const e of entries) {
              if (e.isDirectory() && /^jdk-?\d+/i.test(e.name)) candidates.push(path.join(pf, e.name));
            }
          }
          const pf86 = path.join(programFilesX86, 'Java');
          if (fs.existsSync(pf86)) {
            const entries = fs.readdirSync(pf86, { withFileTypes: true });
            for (const e of entries) {
              if (e.isDirectory() && /^jdk-?\d+/i.test(e.name)) candidates.push(path.join(pf86, e.name));
            }
          }
        } catch (_) {}
        candidates.sort((a, b) => b.localeCompare(a));
        for (const dir of candidates) {
          const javaExe = path.join(dir, 'bin', 'java.exe');
          if (fs.existsSync(javaExe)) {
            process.env.JAVA_HOME = dir;
            process.env.PATH = path.join(dir, 'bin') + path.delimiter + (process.env.PATH || '');
            break;
          }
        }
      }
    }
    const os = require('os');
    const baseTmp = (typeof os.tmpdir === 'function' && os.tmpdir()) || process.cwd();
    const tmpDir = path.resolve(path.join(baseTmp, 'cursor-invoice'));
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmpPdf = path.resolve(path.join(tmpDir, 'invoice-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.pdf'));
    const tmpOut = path.resolve(path.join(tmpDir, 'out-' + Date.now()));
    if (typeof tmpPdf !== 'string' || !tmpPdf || typeof tmpOut !== 'string' || !tmpOut) {
      throw new Error('Invalid temp paths: tmpPdf=' + tmpPdf + ', tmpOut=' + tmpOut);
    }
    fs.writeFileSync(tmpPdf, buffer);
    fs.mkdirSync(tmpOut, { recursive: true });
    const convertOptions = {
      outputDir: tmpOut,
      format: 'json',
      quiet: true,
    };
    if (process.env.OPENDATALOADER_TABLE_METHOD === 'cluster') {
      convertOptions.tableMethod = 'cluster';
    }
    if (process.env.OPENDATALOADER_USE_STRUCT_TREE === '1' || process.env.OPENDATALOADER_USE_STRUCT_TREE === 'true') {
      convertOptions.useStructTree = true;
    }
    // Пакет в CJS вызывает fileURLToPath(import.meta.url) при загрузке → undefined в Node require().
    // Загружаем как ESM через import(), тогда используется ESM-сборка и import.meta.url задан.
    const odl = await import('@opendataloader/pdf');
    await odl.convert([tmpPdf, tmpOut], convertOptions);
    let doc = null;
    const files = fs.readdirSync(tmpOut, { withFileTypes: true });
    for (const e of files) {
      if (e.isFile() && e.name.toLowerCase().endsWith('.json')) {
        const raw = fs.readFileSync(path.join(tmpOut, e.name), 'utf8');
        try {
          doc = JSON.parse(raw);
        } catch (_) {}
        break;
      }
    }
    try {
      fs.unlinkSync(tmpPdf);
      fs.rmSync(tmpOut, { recursive: true, force: true });
    } catch (_) {}
    if (doc && Array.isArray(doc.kids)) {
      const issueDate = extractInvoiceIssueDateFromOdlDoc(doc);
      const found = findInvoiceTableInOdlDoc(doc);
      let rows = [];
      if (found) {
        const extracted = extractInvoiceRowsFromOdlTable(found.table);
        rows = extracted.rows;
      }
      if (rows.length === 0) {
        const fallback = extractInvoiceRowsFromOdlParagraphs(doc);
        if (fallback.rows && fallback.rows.length > 0) rows = fallback.rows;
      }
      if (rows.length > 0) {
        const pypdfText = JSON.stringify(doc).slice(0, 50000);
        return { rows, parser: 'opendataloader', pypdfText, issueDate };
      }
      const pypdfText = JSON.stringify(doc).slice(0, 50000);
      return { rows: [], parser: 'opendataloader', pypdfText, error: 'OPENDATALOADER_EMPTY', issueDate };
    }
    return { rows: [], parser: 'opendataloader', pypdfText: null, error: 'OPENDATALOADER_EMPTY' };
  } catch (err) {
    const msg = err && (typeof err.message === 'string' ? err.message : (err.stack || String(err)));
    const errStr = (msg && String(msg).trim()) ? String(msg).trim() : (err != null ? String(err) : 'Unknown error');
    const errStack = err && err.stack;
    console.error('[OpenDataLoader]', errStr);
    if (errStack) console.error('[OpenDataLoader] stack:', errStack);
    if (errStr && /java|JAVA|not found|ENOENT|spawn/i.test(errStr)) {
      console.error('[OpenDataLoader] Убедитесь, что Java 11+ установлена и в PATH (или задайте JAVA_HOME).');
    }
    return { rows: [], parser: 'opendataloader', pypdfText: null, error: 'OPENDATALOADER_ERROR', errorMessage: errStr, errorStack: errStack };
  }
}

/** Классификация позиции счёта: тип начисления и (для токенов) модель. issueDate — дата счёта YYYY-MM-DD (6-е число = ежемесячное списание). */
function classifyInvoiceItem(description, issueDate) {
  const desc = description && typeof description === 'string' ? description.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim() : '';
  if (/^Cursor (Teams|Business) [A-Za-z]{3} \d+(, \d{4})?\s*[\u2013\u2014\-]\s*[A-Za-z]{3} \d+, \d{4}$/.test(desc)) {
    return { charge_type: 'monthly_subscription', model: null };
  }
  if (/^Fast Premium Requests Per Seat /.test(desc)) {
    return { charge_type: 'fast_premium_per_seat', model: null };
  }
  if (/^\d+ extra fast premium requests? beyond 500\/month /i.test(desc)) {
    return { charge_type: 'fast_premium_usage', model: null };
  }
  if (/^Remaining time on (\d+ × )?Cursor (Teams|Business) /.test(desc)) {
    return { charge_type: 'proration_charge', model: null };
  }
  if (/^Unused time on (\d+ × )?Cursor (Teams|Business) /.test(desc)) {
    return { charge_type: 'proration_refund', model: null };
  }
  if (/^Cursor token fee for /.test(desc)) {
    const m = desc.match(/(?:non-max-|token-based-call-)([a-z0-9]+(?:-[a-z0-9.]+)*)/i) || desc.match(/for\s+([a-z0-9]+(?:-[a-z0-9.]+)*)\s*:/i);
    return { charge_type: 'token_fee', model: m ? m[1] : null };
  }
  if (/^\d+ token-based usage calls to /.test(desc)) {
    const m = desc.match(/to (?:non-max-)?([a-z0-9]+(?:-[a-z0-9.]+)*?)(?:,|\s|$)/i);
    return { charge_type: 'token_usage', model: m ? m[1] : null };
  }
  return { charge_type: 'other', model: null };
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
    const parseResult = await parseCursorInvoicePdf(req.file.buffer);
    const rows = parseResult.rows;
    const filename = req.file.originalname || 'invoice.pdf';
    invoiceParseLog({
      filename,
      parser: parseResult.parser,
      parser_output: parseResult.pypdfText,
      rows_count: rows.length,
      error: parseResult.error,
      error_message: parseResult.errorMessage,
      error_stack: parseResult.errorStack,
    });
    if (parseResult.error) {
      const msg = parseResult.error === 'OPENDATALOADER_DISABLED' ? 'Парсер отключён (USE_OPENDATALOADER=0).'
        : parseResult.error === 'OPENDATALOADER_ERROR'
          ? (parseResult.errorMessage ? 'Ошибка OpenDataLoader: ' + String(parseResult.errorMessage).slice(0, 300) : 'Ошибка OpenDataLoader (требуется Java 11+ в PATH).')
        : 'Таблица строк не распознана.';
      return res.status(400).json({
        error: msg,
        code: parseResult.error,
        ...(parseResult.errorMessage && { error_message: String(parseResult.errorMessage).slice(0, 500) }),
      });
    }
    const invoiceId = db.insertCursorInvoice(filename, null, fileHash, parseResult.issueDate);
    const issueDate = parseResult.issueDate || null;
    rows.forEach((r) => {
      const { charge_type, model } = classifyInvoiceItem(r.description, issueDate);
      db.insertCursorInvoiceItem(invoiceId, r.row_index, r.description, r.amount_cents, r.raw_columns, r.quantity, r.unit_price_cents, r.tax_pct, charge_type, model);
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

/** Все позиции всех счетов для отчёта (report.html). Формат: { items: [ { issue_date, amount_cents, charge_type }, ... ] }. */
app.get('/api/invoices/all-items', requireSettingsAuth, (req, res) => {
  try {
    const invoices = db.getCursorInvoices();
    const items = [];
    for (const inv of invoices) {
      const rows = db.getCursorInvoiceItems(inv.id);
      const issueDate = (inv.issue_date || (inv.parsed_at || '').slice(0, 10)) || null;
      for (const row of rows) {
        items.push({
          issue_date: issueDate,
          invoice_issue_date: issueDate,
          amount_cents: row.amount_cents,
          charge_type: row.charge_type || 'other',
          model: row.model || null,
          description: row.description,
          quantity: row.quantity,
          unit_price_cents: row.unit_price_cents,
          tax_pct: row.tax_pct,
        });
      }
    }
    res.json({ items });
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
    const invoice = db.getCursorInvoiceById(id);
    if (!invoice) return res.status(404).json({ error: 'Счёт не найден.' });
    db.deleteCursorInvoice(id);
    const logPath = getInvoiceLogPath(invoice.filename);
    try {
      if (fs.existsSync(logPath)) fs.unlinkSync(logPath);
    } catch (_) {}
    res.json({ ok: true, message: 'Счёт удалён.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/invoices/clear', requireSettingsAuth, (req, res) => {
  try {
    const invoices = db.getCursorInvoices();
    invoices.forEach((inv) => {
      const logPath = getInvoiceLogPath(inv.filename);
      try {
        if (fs.existsSync(logPath)) fs.unlinkSync(logPath);
      } catch (_) {}
    });
    db.clearCursorInvoicesOnly();
    res.json({ ok: true, message: 'Все счета удалены из БД.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Период биллинга (цикл 6–5): дата YYYY-MM-DD → ключ YYYY-MM (месяц окончания периода). */
function getBillingPeriodKey(dateStr) {
  const s = (dateStr || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const parts = s.split('-').map(Number);
  const y = parts[0], m = parts[1], d = parts[2];
  if (d >= 6) {
    if (m === 12) return (y + 1) + '-01';
    return y + '-' + String(m + 1).padStart(2, '0');
  }
  return y + '-' + String(m).padStart(2, '0');
}

/** Подпись периода для сверки: "6 янв – 5 фев 2026". */
function getBillingPeriodLabel(key) {
  if (!key || key.length < 7) return key || '—';
  const parts = key.split('-').map(Number);
  const endYear = parts[0], endMonth = parts[1];
  const startMonth = endMonth === 1 ? 12 : endMonth - 1;
  const startYear = endMonth === 1 ? endYear - 1 : endYear;
  const mon = (m) => new Date(2020, m - 1, 1).toLocaleDateString('ru-RU', { month: 'short' });
  return '6 ' + mon(startMonth) + ' – 5 ' + mon(endMonth) + ' ' + endYear;
}

/** Сверка: Usage Events vs позиции счетов по периодам биллинга (reconciliation.html). */
app.get('/api/reconciliation', requireSettingsAuth, (req, res) => {
  try {
    const usageRows = db.getAnalytics({ endpoint: '/teams/filtered-usage-events' });
    const byPeriodUsage = {};
    for (const row of usageRows) {
      const payload = row.payload || {};
      const events = payload.usageEvents || [];
      for (const e of events) {
        const dateKey = toDateKey(e.timestamp);
        if (!dateKey) continue;
        const periodKey = getBillingPeriodKey(dateKey);
        if (!periodKey) continue;
        const kind = (e.kind || e.billingKind || '').toString().toLowerCase();
        const isUsageBased = kind === 'usage-based' || kind === 'usage_based';
        if (!isUsageBased) continue;
        if (!byPeriodUsage[periodKey]) byPeriodUsage[periodKey] = { count: 0, cents: 0 };
        byPeriodUsage[periodKey].count += 1;
        const tu = e.tokenUsage || {};
        byPeriodUsage[periodKey].cents += Number(tu.totalCents ?? 0) || 0;
      }
    }
    const invoices = db.getCursorInvoices();
    const byPeriodInvoice = {};
    for (const inv of invoices) {
      const issueDate = inv.issue_date || (inv.parsed_at || '').slice(0, 10) || null;
      const periodKey = getBillingPeriodKey(issueDate);
      if (!periodKey) continue;
      const items = db.getCursorInvoiceItems(inv.id);
      if (!byPeriodInvoice[periodKey]) byPeriodInvoice[periodKey] = { count: 0, cents: 0 };
      for (const it of items) {
        const type = it.charge_type || 'other';
        if (type !== 'token_usage' && type !== 'token_fee') continue;
        byPeriodInvoice[periodKey].count += 1;
        byPeriodInvoice[periodKey].cents += Number(it.amount_cents ?? 0) || 0;
      }
    }
    const allPeriods = new Set([...Object.keys(byPeriodUsage), ...Object.keys(byPeriodInvoice)]);
    const comparison = [];
    let totalUsageCents = 0, totalInvoiceCents = 0;
    for (const key of [...allPeriods].sort()) {
      const u = byPeriodUsage[key] || { count: 0, cents: 0 };
      const i = byPeriodInvoice[key] || { count: 0, cents: 0 };
      const diffCents = i.cents - u.cents;
      totalUsageCents += u.cents;
      totalInvoiceCents += i.cents;
      comparison.push({
        periodLabel: getBillingPeriodLabel(key),
        usageEventCount: u.count,
        usageCostCents: u.cents,
        invoiceItemCount: i.count,
        invoiceCostCents: i.cents,
        diffCents,
      });
    }
    const totalDiffCents = totalInvoiceCents - totalUsageCents;
    res.json({
      comparison,
      totals: { totalUsageCents, totalInvoiceCents, totalDiffCents },
    });
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

app.listen(PORT, function() {
  getAuthCredentials(); // создать data/auth.json при первом запуске при необходимости
  console.log('[APP] Server started successfully');
  console.log('[APP] Listening on: http://localhost:' + PORT);
  console.log('[APP] Logs writing to: ' + LOG_FILE);
  console.log('[APP] Press Ctrl+C to stop');
});
