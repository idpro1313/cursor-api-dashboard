/**
 * Загрузка Jira CSV и PDF-счетов на странице «Настройки и загрузки». Требует common.js (fetchWithAuth).
 * Элементы: jiraCsvFile, btnUploadJira, jiraUploadResult; invoicePdfFile, btnUploadInvoicePdf, invoiceUploadResult.
 */
(function () {
  function showResult(el, message, isError) {
    if (!el) return;
    el.style.display = 'block';
    el.className = isError ? 'sync-result error' : 'sync-result ok';
    el.textContent = message;
  }

  const btnUploadJira = document.getElementById('btnUploadJira');
  if (btnUploadJira) {
    btnUploadJira.addEventListener('click', async function () {
      const input = document.getElementById('jiraCsvFile');
      const resultEl = document.getElementById('jiraUploadResult');
      if (!input || !input.files || !input.files[0]) {
        alert('Выберите файл CSV');
        return;
      }
      const file = input.files[0];
      try {
        const text = await new Promise(function (resolve, reject) {
          const reader = new FileReader();
          reader.onload = function () { resolve(reader.result); };
          reader.onerror = function () { reject(new Error('Не удалось прочитать файл')); };
          reader.readAsText(file, 'UTF-8');
        });
        const r = await fetchWithAuth('/api/jira-users/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ csv: text }),
        });
        if (!r) return;
        const data = await r.json();
        if (!r.ok) {
          showResult(resultEl, data.error || r.statusText, true);
          return;
        }
        showResult(resultEl, data.message || 'Загружено ' + (data.count || 0) + ' записей.', false);
        input.value = '';
      } catch (e) {
        showResult(resultEl, e.message || 'Ошибка загрузки', true);
      }
    });
  }

  const btnUploadInvoicePdf = document.getElementById('btnUploadInvoicePdf');
  if (btnUploadInvoicePdf) {
    btnUploadInvoicePdf.addEventListener('click', async function () {
      const input = document.getElementById('invoicePdfFile');
      const resultEl = document.getElementById('invoiceUploadResult');
      if (!input || !input.files || input.files.length === 0) {
        alert('Выберите один или несколько файлов PDF');
        return;
      }
      const files = Array.from(input.files);
      const total = files.length;
      let uploaded = 0;
      let skipped = 0;
      const errors = [];
      showResult(resultEl, 'Загрузка 0 из ' + total + '…', false);
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const name = file.name || 'файл ' + (i + 1);
        if (resultEl) {
          resultEl.textContent = 'Загрузка ' + (i + 1) + ' из ' + total + ': ' + name + '…';
        }
        try {
          const formData = new FormData();
          formData.append('pdf', file);
          const r = await fetchWithAuth('/api/invoices/upload', { method: 'POST', body: formData });
          if (!r) {
            errors.push(name + ': отмена');
            continue;
          }
          const data = await r.json().catch(function () { return {}; });
          if (r.status === 409 && data.alreadyUploaded) {
            skipped++;
            continue;
          }
          if (!r.ok) {
            errors.push(name + ': ' + (data.error || r.statusText));
            continue;
          }
          uploaded++;
        } catch (e) {
          errors.push(name + ': ' + (e.message || 'Ошибка'));
        }
      }
      input.value = '';
      var msg = 'Загружено: ' + uploaded;
      if (skipped) msg += ', пропущено (уже в базе): ' + skipped;
      if (errors.length) {
        msg += '. Ошибки: ' + errors.join('; ');
        showResult(resultEl, msg, true);
      } else {
        showResult(resultEl, msg + (total > 1 ? ' из ' + total + ' файлов.' : '.'), false);
      }
    });
  }
})();
