/**
 * Локальная БД аналитики Cursor (SQLite).
 * Хранит данные по эндпоинтам и дням без дублирования: один ряд на (endpoint, date).
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'analytics.db');

let db = null;

function getDb() {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS analytics (
      endpoint TEXT NOT NULL,
      date TEXT NOT NULL,
      payload TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (endpoint, date)
    );
    CREATE INDEX IF NOT EXISTS idx_analytics_endpoint ON analytics(endpoint);
    CREATE INDEX IF NOT EXISTS idx_analytics_date ON analytics(date);

    CREATE TABLE IF NOT EXISTS jira_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      data TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS cursor_invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL,
      file_path TEXT,
      file_hash TEXT,
      parsed_at TEXT DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_cursor_invoices_file_hash ON cursor_invoices(file_hash) WHERE file_hash IS NOT NULL;
    CREATE TABLE IF NOT EXISTS cursor_invoice_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id INTEGER NOT NULL REFERENCES cursor_invoices(id) ON DELETE CASCADE,
      row_index INTEGER NOT NULL,
      description TEXT,
      quantity REAL,
      unit_price_cents INTEGER,
      amount_cents INTEGER,
      raw_columns TEXT,
      UNIQUE(invoice_id, row_index)
    );
    CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice_id ON cursor_invoice_items(invoice_id);
  `);
  try {
    const infoInv = db.prepare("PRAGMA table_info(cursor_invoices)").all();
    if (infoInv.length > 0 && infoInv.every((c) => c.name !== 'file_hash')) {
      db.exec('ALTER TABLE cursor_invoices ADD COLUMN file_hash TEXT');
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_cursor_invoices_file_hash ON cursor_invoices(file_hash) WHERE file_hash IS NOT NULL');
    }
  } catch (_) {}
  try {
    const infoItems = db.prepare("PRAGMA table_info(cursor_invoice_items)").all();
    const names = (infoItems || []).map((c) => c.name);
    if (!names.includes('quantity')) db.exec('ALTER TABLE cursor_invoice_items ADD COLUMN quantity REAL');
    if (!names.includes('unit_price_cents')) db.exec('ALTER TABLE cursor_invoice_items ADD COLUMN unit_price_cents INTEGER');
  } catch (_) {}
  return db;
}

const SETTING_API_KEY = 'cursor_api_key';

/** Получить значение настройки (например API key). */
function getSetting(key) {
  const d = getDb();
  const row = d.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? String(row.value).trim() : null;
}

/** Сохранить значение настройки. */
function setSetting(key, value) {
  const d = getDb();
  d.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(key, String(value ?? ''));
}

function upsertAnalytics(endpoint, date, payload) {
  const d = getDb();
  const stmt = d.prepare(`
    INSERT INTO analytics (endpoint, date, payload, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT (endpoint, date) DO UPDATE SET payload = excluded.payload, updated_at = datetime('now')
  `);
  stmt.run(endpoint, date, typeof payload === 'string' ? payload : JSON.stringify(payload));
}

function getAnalytics(options = {}) {
  const d = getDb();
  const { endpoint, startDate, endDate } = options;
  let sql = 'SELECT endpoint, date, payload, updated_at FROM analytics WHERE 1=1';
  const params = [];
  if (endpoint) {
    sql += ' AND endpoint = ?';
    params.push(endpoint);
  }
  if (startDate) {
    sql += ' AND date >= ?';
    params.push(startDate);
  }
  if (endDate) {
    sql += ' AND date <= ?';
    params.push(endDate);
  }
  sql += ' ORDER BY endpoint, date';
  const stmt = d.prepare(sql);
  const rows = stmt.all(...params);
  return rows.map(r => ({
    endpoint: r.endpoint,
    date: r.date,
    payload: (() => {
      try {
        return JSON.parse(r.payload);
      } catch (_) {
        return r.payload;
      }
    })(),
    updated_at: r.updated_at,
  }));
}

/** Возвращает массив дат (YYYY-MM-DD), по которым уже есть данные для эндпоинта в указанном диапазоне. */
function getExistingDates(endpoint, startDate, endDate) {
  const d = getDb();
  const stmt = d.prepare(`
    SELECT DISTINCT date FROM analytics
    WHERE endpoint = ? AND date >= ? AND date <= ?
    ORDER BY date
  `);
  return stmt.all(endpoint, startDate, endDate).map((r) => r.date);
}

function getCoverage() {
  const d = getDb();
  const stmt = d.prepare(`
    SELECT endpoint, MIN(date) AS min_date, MAX(date) AS max_date, COUNT(*) AS days
    FROM analytics
    GROUP BY endpoint
    ORDER BY endpoint
  `);
  return stmt.all();
}

function getJiraUsers() {
  const d = getDb();
  const stmt = d.prepare('SELECT id, data, updated_at FROM jira_users ORDER BY id');
  const rows = stmt.all();
  return rows.map((r) => {
    let data;
    try {
      data = JSON.parse(r.data);
    } catch (_) {
      data = r.data;
    }
    return { id: r.id, data, updated_at: r.updated_at };
  });
}

function replaceJiraUsers(rows) {
  const d = getDb();
  d.exec('DELETE FROM jira_users');
  if (!rows || rows.length === 0) return 0;
  const stmt = d.prepare('INSERT INTO jira_users (data) VALUES (?)');
  const run = d.transaction((list) => {
    for (const row of list) {
      stmt.run(JSON.stringify(row));
    }
  });
  run(rows);
  return rows.length;
}

function getApiKey() {
  return getSetting(SETTING_API_KEY);
}

function setApiKey(apiKey) {
  setSetting(SETTING_API_KEY, apiKey);
}

/** Очистка только данных API (таблица analytics). */
function clearAnalyticsOnly() {
  getDb().exec('DELETE FROM analytics');
}

/** Очистка только данных Jira (таблица jira_users). */
function clearJiraOnly() {
  getDb().exec('DELETE FROM jira_users');
}

function getCursorInvoiceByFileHash(fileHash) {
  if (!fileHash) return null;
  const d = getDb();
  return d.prepare('SELECT id, filename, parsed_at FROM cursor_invoices WHERE file_hash = ?').get(fileHash) || null;
}

function insertCursorInvoice(filename, filePath, fileHash) {
  const d = getDb();
  const stmt = d.prepare('INSERT INTO cursor_invoices (filename, file_path, file_hash) VALUES (?, ?, ?)');
  const run = stmt.run(filename, filePath || null, fileHash || null);
  return run.lastInsertRowid;
}

function insertCursorInvoiceItem(invoiceId, rowIndex, description, amountCents, rawColumns, quantity, unitPriceCents) {
  const d = getDb();
  d.prepare(`
    INSERT INTO cursor_invoice_items (invoice_id, row_index, description, amount_cents, raw_columns, quantity, unit_price_cents)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    invoiceId,
    rowIndex,
    description || null,
    amountCents != null ? amountCents : null,
    rawColumns ? JSON.stringify(rawColumns) : null,
    quantity != null ? quantity : null,
    unitPriceCents != null ? unitPriceCents : null
  );
}

function getCursorInvoiceById(id) {
  const d = getDb();
  return d.prepare('SELECT id, filename, file_path, parsed_at FROM cursor_invoices WHERE id = ?').get(id) || null;
}

function getCursorInvoices() {
  const d = getDb();
  const invoices = d.prepare('SELECT id, filename, file_path, parsed_at FROM cursor_invoices ORDER BY parsed_at DESC').all();
  const itemCounts = d.prepare(`
    SELECT invoice_id, COUNT(*) AS cnt FROM cursor_invoice_items GROUP BY invoice_id
  `).all();
  const countMap = {};
  itemCounts.forEach((r) => { countMap[r.invoice_id] = r.cnt; });
  return invoices.map((inv) => ({ ...inv, items_count: countMap[inv.id] || 0 }));
}

function getCursorInvoiceItems(invoiceId) {
  const d = getDb();
  const rows = d.prepare(`
    SELECT id, invoice_id, row_index, description, quantity, unit_price_cents, amount_cents, raw_columns
    FROM cursor_invoice_items WHERE invoice_id = ? ORDER BY row_index
  `).all(invoiceId);
  return rows.map((r) => ({
    ...r,
    raw_columns: r.raw_columns ? (() => { try { return JSON.parse(r.raw_columns); } catch (_) { return null; } })() : null,
  }));
}

/**
 * Полная очистка БД: таблицы analytics, jira_users, cursor_invoices/invoice_items.
 * Если clearSettings === true, также очищает settings (в т.ч. API key).
 */
function clearAllData(clearSettings = false) {
  const d = getDb();
  d.exec('DELETE FROM cursor_invoice_items');
  d.exec('DELETE FROM cursor_invoices');
  d.exec('DELETE FROM analytics');
  d.exec('DELETE FROM jira_users');
  if (clearSettings) d.exec('DELETE FROM settings');
}

module.exports = {
  getDb,
  upsertAnalytics,
  getAnalytics,
  getCoverage,
  getExistingDates,
  getJiraUsers,
  replaceJiraUsers,
  getSetting,
  setSetting,
  getApiKey,
  setApiKey,
  clearAnalyticsOnly,
  clearJiraOnly,
  clearAllData,
  insertCursorInvoice,
  insertCursorInvoiceItem,
  getCursorInvoices,
  getCursorInvoiceItems,
  getCursorInvoiceByFileHash,
  getCursorInvoiceById,
};
