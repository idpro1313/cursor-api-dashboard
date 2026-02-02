/**
 * Прокси для Cursor Admin API и сохранение данных в локальную БД.
 * API key: заголовок X-API-Key или переменная CURSOR_API_KEY.
 * Документация: https://cursor.com/docs/account/teams/admin-api
 */
const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./db');

const app = express();
const CURSOR_API = 'https://api.cursor.com';
const PROXY_TIMEOUT_MS = Number(process.env.PROXY_TIMEOUT_MS) || 60000;
const MAX_DAYS = 30;

/** Допустимые префиксы путей для прокси (Admin API). */
const ALLOWED_PATH_PREFIXES = ['/teams/', '/settings/'];

function isPathAllowed(apiPath) {
  return ALLOWED_PATH_PREFIXES.some((p) => apiPath.startsWith(p));
}

// Эндпоинты Admin API для синхронизации в БД (без дублирования по дням)
const SYNC_ENDPOINTS = [
  { path: '/teams/members', method: 'GET', syncType: 'snapshot' },
  { path: '/teams/audit-logs', method: 'GET', syncType: 'daterange', paginated: true },
  { path: '/teams/daily-usage-data', method: 'POST', syncType: 'daterange', bodyEpoch: true },
  { path: '/teams/spend', method: 'POST', syncType: 'snapshot' },
  { path: '/teams/filtered-usage-events', method: 'POST', syncType: 'daterange', paginated: true },
  { path: '/teams/groups', method: 'GET', syncType: 'snapshot' },
  { path: '/settings/repo-blocklists/repos', method: 'GET', syncType: 'snapshot' },
];

// CORS: по умолчанию все origins; для продакшена задайте CORS_ORIGIN (например http://localhost:3333)
const corsOrigin = process.env.CORS_ORIGIN;
app.use(cors(corsOrigin ? { origin: corsOrigin.split(',').map(s => s.trim()) } : {}));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Простой rate limit: N запросов с одного IP в минуту (не логируем заголовки — API key не попадает в логи)
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

/** Разбить период на отрезки по 30 дней (лимит API). */
function dateChunks(startDate, endDate) {
  const start = new Date(startDate);
  const end = new Date(endDate);
  const chunks = [];
  let cur = new Date(start);
  while (cur <= end) {
    const chunkEnd = new Date(cur);
    chunkEnd.setDate(chunkEnd.getDate() + MAX_DAYS - 1);
    if (chunkEnd > end) chunkEnd.setTime(end.getTime());
    chunks.push({
      startDate: cur.toISOString().slice(0, 10),
      endDate: chunkEnd.toISOString().slice(0, 10),
    });
    cur.setDate(chunkEnd.getDate() + 1);
  }
  return chunks;
}

/** Запрос к Cursor Admin API с Basic Auth (для синхронизации). */
async function cursorFetch(apiKey, apiPath, options = {}) {
  const { method = 'GET', query = {}, body } = options;
  const url = new URL(apiPath, CURSOR_API);
  Object.entries(query).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  const auth = Buffer.from(apiKey + ':', 'utf8').toString('base64');
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);
  const opts = {
    method,
    headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/json' },
    signal: controller.signal,
  };
  if (body && method === 'POST') opts.body = JSON.stringify(body);
  const r = await fetch(url.toString(), opts);
  clearTimeout(timeoutId);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || data.message || r.statusText);
  return data;
}

/** Timestamp (ms или строка) -> YYYY-MM-DD */
function toDateKey(ts) {
  if (ts == null) return null;
  const ms = typeof ts === 'string' ? new Date(ts).getTime() : Number(ts);
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
  if (endpoint === '/teams/groups' && response.groups) {
    out.push({ date: chunkEndDate, payload: response });
    return out;
  }
  if (endpoint === '/settings/repo-blocklists/repos' && response.repos) {
    out.push({ date: chunkEndDate, payload: response });
    return out;
  }
  return out;
}

function doProxy(apiKey, apiPath, method, query, body, res) {
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
  const apiKey = req.headers['x-api-key'] || process.env.CURSOR_API_KEY;
  if (!apiKey) return res.status(401).json({ error: 'API key required. Set X-API-Key header or CURSOR_API_KEY env.' });
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
  return doProxy(apiKey, apiPath, 'GET', query, null, res);
});

app.post('/api/proxy', async (req, res) => {
  const ip = getClientIp(req);
  if (!checkRateLimit(ip)) return res.status(429).json({ error: 'Слишком много запросов. Подождите минуту.' });
  const apiKey = req.headers['x-api-key'] || process.env.CURSOR_API_KEY;
  if (!apiKey) return res.status(401).json({ error: 'API key required. Set X-API-Key header or CURSOR_API_KEY env.' });
  const { path: apiPath, ...body } = req.body || {};
  if (!apiPath || !isPathAllowed(apiPath)) {
    return res.status(400).json({ error: 'Body path required, допустимы /teams/... и /settings/...' });
  }
  return doProxy(apiKey, apiPath, 'POST', {}, body, res);
});

// --- Синхронизация Admin API в локальную БД (без дублирования по дням) ---

function dateToEpochMs(dateStr) {
  return new Date(dateStr + 'T00:00:00Z').getTime();
}

app.post('/api/sync', async (req, res) => {
  const apiKey = req.headers['x-api-key'] || process.env.CURSOR_API_KEY;
  if (!apiKey) return res.status(401).json({ error: 'API key required. Set X-API-Key header or CURSOR_API_KEY env.' });
  const { startDate, endDate } = req.body || {};
  const validation = validateDateRangeForSync(startDate, endDate);
  if (!validation.ok) return res.status(400).json({ error: validation.error });

  const today = new Date().toISOString().slice(0, 10);
  const end = endDate || today;
  const chunks = dateChunks(startDate, end);
  const results = { ok: [], errors: [], saved: 0 };

  for (const ep of SYNC_ENDPOINTS) {
    try {
      let savedForEp = 0;
      if (ep.syncType === 'snapshot') {
        const chunkEnd = today;
        const response = await cursorFetch(apiKey, ep.path, {
          method: ep.method,
          query: ep.method === 'GET' ? {} : undefined,
          body: ep.method === 'POST' ? {} : undefined,
        });
        const rows = parseResponseToDays(ep.path, response, chunkEnd);
        for (const { date, payload } of rows) {
          db.upsertAnalytics(ep.path, date, payload);
          savedForEp++;
        }
      } else {
        for (const { startDate: chunkStart, endDate: chunkEnd } of chunks) {
          let response;
          if (ep.path === '/teams/audit-logs') {
            const allEvents = [];
            let page = 1;
            const pageSize = 100;
            let hasNext = true;
            while (hasNext) {
              response = await cursorFetch(apiKey, ep.path, {
                method: 'GET',
                query: { startTime: chunkStart, endTime: chunkEnd, page, pageSize },
              });
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
            });
          } else if (ep.path === '/teams/filtered-usage-events') {
            const allEvents = [];
            let page = 1;
            const pageSize = 100;
            let hasNext = true;
            while (hasNext) {
              response = await cursorFetch(apiKey, ep.path, {
                method: 'POST',
                body: {
                  startDate: dateToEpochMs(chunkStart),
                  endDate: dateToEpochMs(chunkEnd),
                  page,
                  pageSize,
                },
              });
              if (Array.isArray(response.usageEvents)) allEvents.push(...response.usageEvents);
              hasNext = response.pagination?.hasNextPage === true;
              page++;
            }
            response = { usageEvents: allEvents, period: response.period };
          } else {
            continue;
          }
          const rows = parseResponseToDays(ep.path, response, chunkEnd);
          for (const { date, payload } of rows) {
            db.upsertAnalytics(ep.path, date, payload);
            savedForEp++;
          }
        }
      }
      results.saved += savedForEp;
      results.ok.push(ep.path);
    } catch (e) {
      results.errors.push({ endpoint: ep.path, error: e.message });
    }
  }

  res.json({
    message: `Сохранено записей по дням: ${results.saved}. Успешно: ${results.ok.length}, ошибок: ${results.errors.length}.`,
    saved: results.saved,
    ok: results.ok,
    errors: results.errors,
  });
});

app.get('/api/analytics', (req, res) => {
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

app.get('/api/analytics/coverage', (req, res) => {
  try {
    const coverage = db.getCoverage();
    res.json({ coverage });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Периодическая очистка старых записей rate limit
setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of rateLimitMap.entries()) {
    if (now >= bucket.resetAt) rateLimitMap.delete(ip);
  }
}, 60000);

const PORT = process.env.PORT || 3333;
app.listen(PORT, () => {
  console.log('Cursor API Dashboard: http://localhost:' + PORT);
});
