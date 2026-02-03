/**
 * Прокси для Cursor Admin API и сохранение данных в локальную БД.
 * API key: заголовок X-API-Key, переменная CURSOR_API_KEY или значение в БД (таблица settings).
 * Документация: https://cursor.com/docs/account/teams/admin-api
 */
const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./db');

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

// Эндпоинты Admin API для синхронизации в БД (рекомендации: https://cursor.com/docs/account/teams/admin-api)
const SYNC_ENDPOINTS = [
  { path: '/teams/members', method: 'GET', syncType: 'snapshot', label: 'Team Members' },
  { path: '/teams/audit-logs', method: 'GET', syncType: 'daterange', paginated: true, label: 'Audit Logs' },
  { path: '/teams/daily-usage-data', method: 'POST', syncType: 'daterange', bodyEpoch: true, label: 'Daily Usage Data' },
  { path: '/teams/spend', method: 'POST', syncType: 'snapshot', label: 'Spending Data' },
  { path: '/teams/filtered-usage-events', method: 'POST', syncType: 'daterange', paginated: true, label: 'Usage Events' },
];

// CORS: по умолчанию все origins; для продакшена задайте CORS_ORIGIN (например http://localhost:3333)
const corsOrigin = process.env.CORS_ORIGIN;
app.use(cors(corsOrigin ? { origin: corsOrigin.split(',').map(s => s.trim()) } : {}));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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
  while (timestamps.length >= limit) {
    const oldest = Math.min(...timestamps);
    const waitMs = oldest + CURSOR_RATE_WINDOW_MS - now + 50;
    await new Promise((r) => setTimeout(r, Math.max(50, waitMs)));
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
async function cursorFetch(apiKey, apiPath, options = {}) {
  const { method = 'GET', query = {}, body } = options;
  const url = new URL(apiPath, CURSOR_API);
  Object.entries(query).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  const auth = Buffer.from(apiKey + ':', 'utf8').toString('base64');
  const opts = {
    method,
    headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/json' },
  };
  if (body && method === 'POST') opts.body = JSON.stringify(body);

  for (let attempt = 0; attempt <= RATE_LIMIT_MAX_RETRIES; attempt++) {
    await waitCursorRateLimit(apiPath);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);
    opts.signal = controller.signal;
    const r = await fetch(url.toString(), opts);
    clearTimeout(timeoutId);
    const data = await r.json().catch(() => ({}));

    if (r.status === 429 && attempt < RATE_LIMIT_MAX_RETRIES) {
      const waitMs = RATE_LIMIT_BACKOFF_BASE_MS * Math.pow(2, attempt);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      continue;
    }
    if (r.status === 401) throw new Error('INVALID_API_KEY');
    if (!r.ok) throw new Error(data.error || data.message || r.statusText);
    return data;
  }
  throw new Error('Rate limit exceeded. Please try again later.');
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
  return out;
}

// Конфигурация API key (хранится в БД, таблица settings)
app.get('/api/config', (req, res) => {
  res.json({ apiKeyConfigured: isApiKeyConfigured() });
});

app.post('/api/config', (req, res) => {
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
  const yesterday = getYesterdayStr();
  const endCapped = !endDate || endDate > yesterday ? yesterday : endDate;
  const chunksToFetch = getChunksToFetch(startDate, endCapped);
  const totalSteps = getSyncTotalSteps(chunksToFetch);
  const results = { ok: [], errors: [], skipped: [], saved: 0 };
  let currentStep = 0;

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
        });
        const rows = parseResponseToDays(ep.path, response, chunkEnd);
        for (const { date, payload } of rows) {
          db.upsertAnalytics(ep.path, date, payload);
          savedForEp++;
        }
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
          let stepSaved = 0;
          for (const { date, payload } of rows) {
            db.upsertAnalytics(ep.path, date, payload);
            savedForEp++;
            stepSaved++;
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
              daysInStep: rows.length,
            });
          }
        }
      }
      results.saved += savedForEp;
      results.ok.push(ep.path);
    } catch (e) {
      if (isFeatureNotEnabled(e.message)) {
        results.skipped.push({ endpoint: ep.path, reason: 'Функция не включена для команды' });
        results.ok.push(ep.path);
      } else {
        results.errors.push({ endpoint: ep.path, error: e.message });
      }
    }
  }

  const skippedNote = results.skipped.length ? ` Пропущено (функция не включена): ${results.skipped.length}.` : '';
  return {
    message: `Сохранено записей по дням: ${results.saved}. Успешно: ${results.ok.length}, ошибок: ${results.errors.length}.${skippedNote}`,
    saved: results.saved,
    ok: results.ok,
    errors: results.errors,
    skipped: results.skipped,
  };
}

app.post('/api/sync', async (req, res) => {
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
app.post('/api/sync-stream', async (req, res) => {
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

/** Полная очистка БД: analytics и jira_users; при clearSettings: true — также settings (API key). */
app.post('/api/clear-db', (req, res) => {
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

/** Дата из строки Jira для сортировки (последняя запись = самый поздний статус). Возвращает timestamp или id. */
function getJiraRowOrderKey(row, id) {
  const dateKeys = ['Дата', 'Date', 'Created', 'Создан', 'Обновлён', 'Updated', 'Дата изменения', 'Дата выдачи'];
  for (const k of dateKeys) {
    const v = row[k];
    if (v == null || String(v).trim() === '') continue;
    const d = new Date(String(v).trim());
    if (!isNaN(d.getTime())) return d.getTime();
  }
  return id;
}

/** Агрегация активности по пользователям и месяцам (Daily Usage Data + опционально applies/accepts из API). */
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
    const analyticsRows = db.getAnalytics({
      endpoint: '/teams/daily-usage-data',
      startDate,
      endDate,
    });
    const emailByMonth = new Map();
    const monthSet = new Set();
    for (const row of analyticsRows) {
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
          rec = { month, activeDays: 0, requests: 0, linesAdded: 0, linesDeleted: 0, applies: 0, accepts: 0 };
          emailByMonth.set(key, rec);
        }
        rec.activeDays += 1;
        rec.requests += Number(r.composer_requests ?? r.composerRequests ?? 0) + Number(r.chat_requests ?? r.chatRequests ?? 0) + Number(r.agent_requests ?? r.agentRequests ?? 0);
        rec.linesAdded += Number(r.total_lines_added ?? r.totalLinesAdded ?? 0) + Number(r.accepted_lines_added ?? r.acceptedLinesAdded ?? 0);
        rec.linesDeleted += Number(r.total_lines_deleted ?? r.totalLinesDeleted ?? 0) + Number(r.accepted_lines_deleted ?? r.acceptedLinesDeleted ?? 0);
        rec.applies += Number(r.total_applies ?? r.totalApplies ?? 0);
        rec.accepts += Number(r.total_accepts ?? r.totalAccepts ?? 0);
      }
    }
    const months = Array.from(monthSet).sort();
    const users = [];
    const jiraEmails = new Set();
    // По каждому email из Jira берём самую позднюю запись (по дате из строки или по id) — по ней показываем статус
    const emailToLatestJira = new Map();
    for (let i = 0; i < jiraRows.length; i++) {
      const { id, data: jira } = jiraRows[i];
      const email = getEmailFromJiraRow(jira, allKeys);
      if (!email) continue;
      jiraEmails.add(email);
      const orderKey = getJiraRowOrderKey(jira, id);
      const existing = emailToLatestJira.get(email);
      if (!existing || orderKey > existing.orderKey) {
        emailToLatestJira.set(email, { jira, id, orderKey });
      }
    }
    for (const [email, { jira }] of emailToLatestJira) {
      const displayName = jira['Пользователь, которому выдан доступ'] || jira['Display Name'] || jira['Username'] || jira['Name'] || email || '—';
      const jiraStatus = getJiraStatusFromRow(jira);
      const monthlyActivity = months.map((month) => {
        const rec = emailByMonth.get(email + '\n' + month);
        return rec ? { month, ...rec } : { month, activeDays: 0, requests: 0, linesAdded: 0, linesDeleted: 0, applies: 0, accepts: 0 };
      });
      users.push({ jira, email, displayName: String(displayName), jiraStatus, monthlyActivity });
    }
    const cursorOnlyEmails = new Set();
    for (const key of emailByMonth.keys()) {
      const email = key.split('\n')[0];
      if (email && !jiraEmails.has(email)) cursorOnlyEmails.add(email);
    }
    for (const email of cursorOnlyEmails) {
      const monthlyActivity = months.map((month) => {
        const rec = emailByMonth.get(email + '\n' + month);
        return rec ? { month, ...rec } : { month, activeDays: 0, requests: 0, linesAdded: 0, linesDeleted: 0, applies: 0, accepts: 0 };
      });
      users.push({ jira: {}, email, displayName: email, jiraStatus: null, monthlyActivity });
    }
    res.json({ users, months });
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

app.post('/api/jira-users/upload', (req, res) => {
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
