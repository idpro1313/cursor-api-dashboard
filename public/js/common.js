/**
 * Общие утилиты для страниц дашборда: экранирование HTML, копирование таблиц, подписи эндпоинтов, форматтеры (даты, центы, токены).
 * Подключать первым перед страничными скриптами.
 */
(function () {
  'use strict';

  function escapeHtml(s) {
    if (s == null) return '';
    const div = document.createElement('div');
    div.textContent = String(s);
    return div.innerHTML;
  }

  const COPY_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

  function tableToTsv(table) {
    const rows = [];
    table.querySelectorAll('tr').forEach(function (tr) {
      const cells = [];
      tr.querySelectorAll('th, td').forEach(function (cell) {
        const text = (cell.textContent || '').trim().replace(/\s+/g, ' ').replace(/\t/g, ' ').replace(/\n/g, ' ');
        cells.push(text);
      });
      if (cells.length) rows.push(cells.join('\t'));
    });
    return rows.join('\n');
  }

  function showCopyFeedback(btn, message) {
    const feedback = btn.parentElement && btn.parentElement.querySelector('.copy-feedback');
    if (feedback) {
      feedback.textContent = message;
      feedback.classList.add('visible');
      setTimeout(function () {
        feedback.textContent = '';
        feedback.classList.remove('visible');
      }, 2000);
    }
  }

  function copyTableFromButton(ev) {
    const btn = ev.target.closest('.btn-copy-table');
    if (!btn) return;
    const id = btn.getAttribute('data-copy-target');
    if (!id) return;
    const el = document.querySelector(id);
    if (!el) return;
    const table = el.tagName === 'TABLE' ? el : el.querySelector('table');
    if (!table) return;
    const tsv = tableToTsv(table);

    function onSuccess() { showCopyFeedback(btn, 'Скопировано'); }
    function onError() { showCopyFeedback(btn, 'Ошибка'); }

    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(tsv).then(onSuccess).catch(onError);
      return;
    }
    try {
      const textarea = document.createElement('textarea');
      textarea.value = tsv;
      textarea.style.position = 'fixed';
      textarea.style.left = '-9999px';
      textarea.setAttribute('readonly', '');
      document.body.appendChild(textarea);
      textarea.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(textarea);
      if (ok) onSuccess(); else onError();
    } catch (e) {
      onError();
    }
  }

  var copyDelegateBound = false;
  function initCopy() {
    if (copyDelegateBound) return;
    copyDelegateBound = true;
    document.body.addEventListener('click', copyTableFromButton);
  }

  var ENDPOINT_LABELS = {
    '/teams/members': 'Team Members',
    '/teams/audit-logs': 'Audit Logs',
    '/teams/daily-usage-data': 'Daily Usage Data',
    '/teams/spend': 'Spending Data',
    '/teams/filtered-usage-events': 'Usage Events',
  };

  function getEndpointLabel(path) {
    return ENDPOINT_LABELS[path] || path;
  }

  /** fetch с credentials; при 401 — редирект на /login.html и возврат null. */
  function fetchWithAuth(url, opts) {
    var options = Object.assign({ credentials: 'same-origin' }, opts || {});
    return fetch(url, options).then(function (r) {
      if (r.status === 401) {
        window.location.href = '/login.html';
        return null;
      }
      return r;
    });
  }

  /** Собрать все уникальные ключи из массива объектов (для построения заголовков таблицы). */
  function getAllKeys(arr) {
    var set = {};
    (arr || []).forEach(function (obj) {
      if (obj && typeof obj === 'object') Object.keys(obj).forEach(function (k) { set[k] = true; });
    });
    return Object.keys(set);
  }

  /** Центы → строка числа без символа валюты (например "12,5"). */
  function formatCostCents(cents) {
    if (cents == null || cents === 0) return '0';
    var d = (Number(cents) / 100).toFixed(2);
    return d.replace(/\.?0+$/, '') || '0';
  }

  /** Центы → "—" или "$X.XX" / "-$X.XX" для отображения в интерфейсе. */
  function formatCentsDollar(cents) {
    if (cents == null) return '—';
    var s = formatCostCents(cents);
    if (s.indexOf('-') === 0) return '-' + '$' + s.slice(1);
    return '$' + s;
  }

  /** Строка YYYY-MM → подпись месяца (например "янв 2025"). */
  function formatMonthLabel(monthStr) {
    if (!monthStr || String(monthStr).length < 7) return monthStr || '—';
    var parts = String(monthStr).split('-').map(Number);
    var y = parts[0], m = parts[1] || 1;
    var d = new Date(y, m - 1, 1);
    return d.toLocaleDateString('ru-RU', { month: 'short', year: 'numeric' });
  }

  /** Строка YYYY-MM → короткая подпись (например "янв 25"). */
  function formatMonthShort(monthStr) {
    if (!monthStr || String(monthStr).length < 7) return monthStr || '—';
    var parts = String(monthStr).split('-').map(Number);
    var y = parts[0], m = parts[1] || 1;
    var d = new Date(y, m - 1, 1);
    return d.toLocaleDateString('ru-RU', { month: 'short', year: '2-digit' });
  }

  /** Большие числа: М/К (например "1,5К", "25,88М"). */
  function formatTokensShort(n) {
    if (n == null || n === 0) return '0';
    var num = Number(n);
    if (num >= 1e6) return (num / 1e6).toFixed(2).replace('.', ',') + 'М';
    if (num >= 1e3) return (num / 1e3).toFixed(2).replace('.', ',') + 'К';
    return String(Math.round(num));
  }

  /** Timestamp (число или строка) → локальная дата и время (короткий формат). */
  function formatAuditDate(ts) {
    if (ts == null) return '—';
    var d = new Date(typeof ts === 'number' ? ts : Number(ts) || ts);
    return isNaN(d.getTime()) ? String(ts) : d.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
  }

  /** Строка YYYY-MM-DD → DD.MM.YYYY. */
  function formatJiraDate(ymd) {
    if (!ymd || String(ymd).length < 10) return '—';
    var parts = String(ymd).slice(0, 10).split('-');
    return parts.length === 3 ? parts[2] + '.' + parts[1] + '.' + parts[0] : ymd;
  }

  window.escapeHtml = escapeHtml;
  window.COPY_ICON_SVG = COPY_ICON_SVG;
  window.tableToTsv = tableToTsv;
  window.showCopyFeedback = showCopyFeedback;
  window.copyTableFromButton = copyTableFromButton;
  window.ENDPOINT_LABELS = ENDPOINT_LABELS;
  window.getEndpointLabel = getEndpointLabel;
  window.fetchWithAuth = fetchWithAuth;
  window.getAllKeys = getAllKeys;
  window.formatCostCents = formatCostCents;
  window.formatCentsDollar = formatCentsDollar;
  window.formatMonthLabel = formatMonthLabel;
  window.formatMonthShort = formatMonthShort;
  window.formatTokensShort = formatTokensShort;
  window.formatAuditDate = formatAuditDate;
  window.formatJiraDate = formatJiraDate;

  /** Текущая страница: из window.PAGE_ID или из pathname (например index.html → index). */
  function getPageId() {
    if (typeof window.PAGE_ID === 'string' && window.PAGE_ID) return window.PAGE_ID;
    var path = (window.location.pathname || '').replace(/^\//, '').replace(/\.html$/, '');
    return path || 'index';
  }

  /** Конфигурация навигации: главная цель — контроль и учёт расходов на Cursor. */
  var NAV_CONFIG = {
    title: 'Учёт Cursor',
    slogan: 'Контроль и учёт расходов на Cursor',
    items: [
      { id: 'index', label: 'Главная', href: 'index.html' },
      { id: 'team-snapshot', label: 'Расходы', href: 'team-snapshot.html' },
      { id: 'invoices', label: 'Счета и учёт', href: 'invoices.html' },
      { id: 'settings', label: 'Настройки', href: 'settings.html' },
    ],
    loginHref: 'login.html',
  };

  /** Построить шапку с навигацией и кнопкой Войти/Выйти. */
  function renderNav(containerId, pageId) {
    var container = document.getElementById(containerId);
    if (!container) return;
    pageId = pageId || getPageId();
    var auth = window.__navAuth;
    var html = '<div class="site-wrap"><div class="header-inner"><a href="index.html" class="site-logo">' + escapeHtml(NAV_CONFIG.title) + '</a>';
    html += '<nav class="nav-links">';
    NAV_CONFIG.items.forEach(function (item) {
      var isCurrent = item.id === pageId;
      html += '<a href="' + escapeHtml(item.href) + '" class="' + (isCurrent ? 'current' : '') + '">' + escapeHtml(item.label) + '</a>';
    });
    if (auth) {
      html += '<a href="#" class="btn btn-secondary btn-small" id="nav-btn-logout">Выйти</a>';
    } else {
      html += '<a href="' + escapeHtml(NAV_CONFIG.loginHref) + '" class="btn btn-small">Войти</a>';
    }
    html += '</nav></div></div>';
    container.innerHTML = html;
    var logoutBtn = document.getElementById('nav-btn-logout');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', function (e) {
        e.preventDefault();
        fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }).then(function () {
          window.location.href = 'index.html';
        });
      });
    }
  }

  /** Построить футер. */
  function renderFooter(footerId) {
    var footer = document.getElementById(footerId);
    if (!footer) return;
    var year = new Date().getFullYear();
    footer.innerHTML =
      '<div class="site-wrap site-footer-inner">' +
      '<span class="site-footer-logo">' + escapeHtml(NAV_CONFIG.title) + '</span>' +
      '<span class="site-footer-slogan">' + escapeHtml(NAV_CONFIG.slogan) + '</span>' +
      '<p class="site-footer-copy">&copy; ' + year + '</p>' +
      '</div>';
  }

  /** Проверить авторизацию и обновить window.__navAuth; вызвать renderNav после. */
  function checkAuthAndRenderNav(containerId, footerId, pageId) {
    pageId = pageId || getPageId();
    fetch('/api/auth/check', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        window.__navAuth = data && data.authenticated === true;
        renderNav(containerId, pageId);
        if (footerId) renderFooter(footerId);
      })
      .catch(function () {
        window.__navAuth = false;
        renderNav(containerId, pageId);
        if (footerId) renderFooter(footerId);
      });
  }

  window.getPageId = getPageId;
  window.NAV_CONFIG = NAV_CONFIG;
  window.renderNav = renderNav;
  window.renderFooter = renderFooter;
  window.checkAuthAndRenderNav = checkAuthAndRenderNav;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initCopy);
  } else {
    initCopy();
  }
})();
