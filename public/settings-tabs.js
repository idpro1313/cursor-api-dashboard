/**
 * Переключение табов на странице настроек (Загрузка в БД | Данные в БД | Jira | Аудит).
 */
(function () {
  'use strict';

  function getTab() {
    var hash = (window.location.hash || '#admin').slice(1);
    return ['admin', 'data', 'jira', 'audit'].indexOf(hash) !== -1 ? hash : 'admin';
  }

  function switchTab(tabId) {
    tabId = tabId || getTab();
    var tabs = document.getElementById('settings-tabs');
    if (tabs) {
      tabs.querySelectorAll('a').forEach(function (a) {
        a.classList.toggle('active', a.getAttribute('data-tab') === tabId);
      });
    }
    document.querySelectorAll('.tab-pane').forEach(function (p) {
      p.classList.toggle('active', p.id === 'pane-' + tabId);
    });
    window.location.hash = tabId;
  }

  function init() {
    var tabs = document.getElementById('settings-tabs');
    if (tabs) {
      tabs.querySelectorAll('a').forEach(function (a) {
        a.addEventListener('click', function (e) {
          e.preventDefault();
          switchTab(a.getAttribute('data-tab'));
        });
      });
    }
    window.addEventListener('hashchange', function () { switchTab(getTab()); });
    switchTab(getTab());
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
