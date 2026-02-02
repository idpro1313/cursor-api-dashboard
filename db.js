/**
 * Локальная БД аналитики Cursor (SQLite).
 * Хранит данные по эндпоинтам и дням без дублирования: один ряд на (endpoint, date).
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
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
  `);
  return db;
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

module.exports = {
  getDb,
  upsertAnalytics,
  getAnalytics,
  getCoverage,
  getJiraUsers,
  replaceJiraUsers,
};
