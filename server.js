/**
 * Прокси для Cursor Admin API и сохранение данных в локальную БД.
 * API key: заголовок X-API-Key, переменная CURSOR_API_KEY или файл data/api-key.txt.
 * Документация: https://cursor.com/docs/account/teams/admin-api
 */
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const db = require('./db');

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const API_KEY_FILE = path.join(DATA_DIR, 'api-key.txt');

function getApiKeyFromFile() {
  try {
    if (fs.existsSync(API_KEY_FILE)) {
      const key = fs.readFileSync(API_KEY_FILE, 'utf8').trim();
      if (key) return key;
    }
  } catch (_) {}
  return null;
}

function isApiKeyConfigured() {
  return !!(process.env.CURSOR_API_KEY || getApiKeyFromFile());
}

function getApiKey(req) {
  return req.headers['x-api-key'] || process.env.CURSOR_API_KEY || getApiKeyFromFile();
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

/** Запрос к Cursor Admin API с Basic Auth (для синхронизации). Соблюдает лимиты Cursor (20/60 запр/мин). */
async function cursorFetch(apiKey, apiPath, options = {}) {
  await waitCursorRateLimit(apiPath);
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
  return out;
}

// Конфигурация API key (файл data/api-key.txt)
app.get('/api/config', (req, res) => {
  res.json({ apiKeyConfigured: isApiKeyConfigured() });
});

app.post('/api/config', (req, res) => {
  const apiKey = (req.body && req.body.apiKey) ? String(req.body.apiKey).trim() : '';
  if (!apiKey) return res.status(400).json({ error: 'Требуется apiKey в теле запроса.' });
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(API_KEY_FILE, apiKey, 'utf8');
    res.json({ ok: true, message: 'Ключ сохранён в data/api-key.txt' });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Ошибка записи файла' });
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
  if (!apiKey) return res.status(401).json({ error: 'API key required. Укажите X-API-Key, CURSOR_API_KEY или создайте файл data/api-key.txt.' });
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

/** Подсчёт общего числа шагов синхронизации (для прогресса). */
function getSyncTotalSteps(chunks) {
  return SYNC_ENDPOINTS.reduce(
    (acc, ep) => acc + (ep.syncType === 'snapshot' ? 1 : chunks.length),
    0
  );
}

function isFeatureNotEnabled(msg) {
  return msg && /not enabled|feature is not enabled/i.test(String(msg));
}

/**
 * Выполняет синхронизацию в БД. onProgress({ currentStep, totalSteps, endpointLabel, chunkLabel, savedInStep, totalSaved }) вызывается после каждого шага.
 * Возвращает { message, saved, ok, errors, skipped }.
 */
async function runSyncToDB(apiKey, startDate, endDate, onProgress) {
  const today = new Date().toISOString().slice(0, 10);
  const end = endDate || today;
  const chunks = dateChunks(startDate, end);
  const totalSteps = getSyncTotalSteps(chunks);
  const results = { ok: [], errors: [], skipped: [], saved: 0 };
  let currentStep = 0;

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
        currentStep++;
        if (onProgress) {
          onProgress({
            currentStep,
            totalSteps,
            endpointLabel: ep.label || ep.path,
            chunkLabel: null,
            savedInStep: savedForEp,
            totalSaved: results.saved + savedForEp,
          });
        }
      } else {
        let chunkIndex = 0;
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
            chunkIndex++;
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
              currentStep,
              totalSteps,
              endpointLabel: ep.label || ep.path,
              chunkLabel: `${chunkStart} – ${chunkEnd}`,
              savedInStep: stepSaved,
              totalSaved: results.saved + savedForEp,
            });
          }
          chunkIndex++;
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
    return res.status(401).json({ error: 'API key required.' });
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
    const result = await runSyncToDB(apiKey, startDate, end, (p) => send({ type: 'progress', ...p }));
    send({ type: 'done', ...result });
  } catch (e) {
    send({ type: 'error', error: e.message });
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
    for (const jira of jiraUsers) {
      const email = getEmailFromJiraRow(jira, allKeys);
      if (email) jiraEmails.add(email);
      const displayName = jira['Пользователь, которому выдан доступ'] || jira['Display Name'] || jira['Username'] || jira['Name'] || email || '—';
      const monthlyActivity = months.map((month) => {
        const rec = email ? emailByMonth.get(email + '\n' + month) : null;
        return rec ? { month, ...rec } : { month, activeDays: 0, requests: 0, linesAdded: 0, linesDeleted: 0, applies: 0, accepts: 0 };
      });
      users.push({ jira, email, displayName: String(displayName), monthlyActivity });
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
      users.push({ jira: {}, email, displayName: email, monthlyActivity });
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
