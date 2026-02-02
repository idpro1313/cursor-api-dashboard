/**
 * Прокси для Cursor Analytics API и сохранение аналитики в локальную БД.
 * API key: заголовок X-API-Key или переменная CURSOR_API_KEY.
 * Документация: https://cursor.com/docs/account/teams/analytics-api
 */
const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./db');

const app = express();
const CURSOR_API = 'https://api.cursor.com';
const PROXY_TIMEOUT_MS = Number(process.env.PROXY_TIMEOUT_MS) || 60000;
const MAX_DAYS = 30;

// Все эндпоинты Analytics API для синхронизации в БД (без дублирования по дням)
const SYNC_ENDPOINTS = [
  { path: '/analytics/team/agent-edits', paginated: false },
  { path: '/analytics/team/tabs', paginated: false },
  { path: '/analytics/team/dau', paginated: false },
  { path: '/analytics/team/client-versions', paginated: false },
  { path: '/analytics/team/models', paginated: false },
  { path: '/analytics/team/top-file-extensions', paginated: false },
  { path: '/analytics/team/mcp', paginated: false },
  { path: '/analytics/team/commands', paginated: false },
  { path: '/analytics/team/plans', paginated: false },
  { path: '/analytics/team/ask-mode', paginated: false },
  { path: '/analytics/team/leaderboard', paginated: false },
  { path: '/analytics/by-user/agent-edits', paginated: true },
  { path: '/analytics/by-user/tabs', paginated: true },
  { path: '/analytics/by-user/models', paginated: true },
  { path: '/analytics/by-user/top-file-extensions', paginated: true },
  { path: '/analytics/by-user/client-versions', paginated: true },
  { path: '/analytics/by-user/mcp', paginated: true },
  { path: '/analytics/by-user/commands', paginated: true },
  { path: '/analytics/by-user/plans', paginated: true },
  { path: '/analytics/by-user/ask-mode', paginated: true },
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

/** Запрос к Cursor API с Basic Auth (для синхронизации). */
async function cursorFetch(apiKey, apiPath, params = {}) {
  const url = new URL(apiPath, CURSOR_API);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  const auth = Buffer.from(apiKey + ':', 'utf8').toString('base64');
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);
  const r = await fetch(url.toString(), {
    headers: { Authorization: 'Basic ' + auth },
    signal: controller.signal,
  });
  clearTimeout(timeoutId);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || data.message || r.statusText);
  return data;
}

/** Разобрать ответ API по дням для сохранения в БД (без дублирования по дате). */
function parseResponseToDays(endpoint, response, chunkEndDate) {
  const out = [];
  const data = response.data;
  if (Array.isArray(data)) {
    const byDate = {};
    for (const r of data) {
      const d = r.event_date || r.date;
      if (!d) continue;
      if (!byDate[d]) byDate[d] = [];
      byDate[d].push(r);
    }
    for (const [date, arr] of Object.entries(byDate)) out.push({ date, payload: arr });
    return out;
  }
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const isLeaderboard = data.tab_leaderboard != null || data.agent_leaderboard != null;
    if (isLeaderboard) {
      out.push({ date: chunkEndDate, payload: { data, params: response.params } });
      return out;
    }
    const byDate = {};
    for (const email of Object.keys(data)) {
      const list = data[email];
      if (!Array.isArray(list)) continue;
      for (const r of list) {
        const d = r.event_date || r.date;
        if (!d) continue;
        if (!byDate[d]) byDate[d] = {};
        if (!byDate[d][email]) byDate[d][email] = [];
        byDate[d][email].push(r);
      }
    }
    for (const [date, payload] of Object.entries(byDate)) out.push({ date, payload });
    return out;
  }
  return out;
}

app.get('/api/proxy', async (req, res) => {
  const ip = getClientIp(req);
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Слишком много запросов. Подождите минуту.' });
  }

  const apiKey = req.headers['x-api-key'] || process.env.CURSOR_API_KEY;
  if (!apiKey) {
    return res.status(401).json({ error: 'API key required. Set X-API-Key header or CURSOR_API_KEY env.' });
  }

  const apiPath = req.query.path;
  if (!apiPath || !apiPath.startsWith('/analytics/')) {
    return res.status(400).json({ error: 'Query param path required, e.g. path=/analytics/team/dau' });
  }

  const startDate = req.query.startDate;
  const endDate = req.query.endDate;
  if (startDate || endDate) {
    const validation = validateDateRange(startDate, endDate);
    if (!validation.ok) return res.status(400).json({ error: validation.error });
  }

  const url = new URL(apiPath, CURSOR_API);
  Object.keys(req.query).forEach(k => {
    if (k !== 'path') url.searchParams.set(k, req.query[k]);
  });

  const auth = Buffer.from(apiKey + ':', 'utf8').toString('base64');
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);

  try {
    const r = await fetch(url.toString(), {
      headers: { Authorization: 'Basic ' + auth },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.status(r.status).json(data || { error: r.statusText });
    }
    res.json(data);
  } catch (e) {
    clearTimeout(timeoutId);
    if (e.name === 'AbortError') {
      return res.status(504).json({ error: 'Таймаут запроса к Cursor API.' });
    }
    res.status(502).json({ error: e.message || 'Proxy request failed' });
  }
});

// --- Синхронизация аналитики в локальную БД (без дублирования по дням) ---

app.post('/api/sync', async (req, res) => {
  const apiKey = req.headers['x-api-key'] || process.env.CURSOR_API_KEY;
  if (!apiKey) {
    return res.status(401).json({ error: 'API key required. Set X-API-Key header or CURSOR_API_KEY env.' });
  }
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
      for (const { startDate: chunkStart, endDate: chunkEnd } of chunks) {
        let response;
        if (ep.paginated) {
          let allData = {};
          let page = 1;
          const pageSize = 500;
          let hasNext = true;
          while (hasNext) {
            response = await cursorFetch(apiKey, ep.path, {
              startDate: chunkStart,
              endDate: chunkEnd,
              page,
              pageSize,
            });
            if (response.data && typeof response.data === 'object' && !Array.isArray(response.data)) {
              Object.assign(allData, response.data);
            }
            hasNext = response.pagination?.hasNextPage === true;
            page++;
          }
          response = { data: allData, params: response.params };
        } else {
          response = await cursorFetch(apiKey, ep.path, { startDate: chunkStart, endDate: chunkEnd });
        }
        const rows = parseResponseToDays(ep.path, response, chunkEnd);
        for (const { date, payload } of rows) {
          db.upsertAnalytics(ep.path, date, payload);
          savedForEp++;
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
