// patch.js — fixes for Clarity Console
(function() {
  'use strict';

  function getActiveTab() {
    var active = document.querySelector('.nav-item.active');
    if (!active) return null;
    var onclick = active.getAttribute('onclick') || '';
    var match = onclick.match(/goTo\('(\w+)'\)/);
    return match ? match[1] : null;
  }

  function waitForApp(callback) {
    if (typeof window.renderTracker === 'function' && typeof window.goTo === 'function') {
      callback();
    } else {
      setTimeout(function() { waitForApp(callback); }, 100);
    }
  }

  // Shared field mappings
  var SHARED_FIELDS = {
    revenue: [
      { tool: 'truth', field: 'revenue' },
      { tool: 'pnl',   field: 'revenue' },
      { tool: 'snapshot', field: 'revenue' },
    ],
    expenses: [
      { tool: 'truth', field: 'expenses' },
      { tool: 'snapshot', field: 'expenses' },
      { tool: 'pnl',   field: 'opex' },
    ],
    cash: [
      { tool: 'truth', field: 'bank' },
      { tool: 'lag',   field: 'cash' },
      { tool: 'snapshot', field: 'cash' },
    ],
  };

  function getSharedConcept(tool, field) {
    for (var concept in SHARED_FIELDS) {
      var fields = SHARED_FIELDS[concept];
      for (var i = 0; i < fields.length; i++) {
        if (fields[i].tool === tool && fields[i].field === field) return concept;
      }
    }
    return null;
  }

  // Sync value across all tools sharing the same concept
  // Uses goTo to navigate to each tool briefly isn't practical — 
  // instead write directly to the hidden currentData via renderTool side effects
  function syncSharedField(concept, value, sourceTool) {
    var fields = SHARED_FIELDS[concept];
    if (!fields || !value) return;
    // We can't access currentData directly, but we can use getToolData
    // via the global renderTool — instead store in a pending sync object
    // that gets applied when the user navigates to each tool
    if (!window._pendingSync) window._pendingSync = {};
    fields.forEach(function(f) {
      if (f.tool === sourceTool) return;
      if (!window._pendingSync[f.tool]) window._pendingSync[f.tool] = {};
      window._pendingSync[f.tool][f.field] = value;
    });
  }

  // Apply pending syncs when a tool loads
  function applyPendingSync(tool) {
    if (!window._pendingSync || !window._pendingSync[tool]) return;
    var pending = window._pendingSync[tool];
    delete window._pendingSync[tool];
    // Find inputs on the page and set their values + trigger input event
    Object.keys(pending).forEach(function(field) {
      var input = document.querySelector('.tool-input[data-tool="'+tool+'"][data-key="'+field+'"]');
      if (input && pending[field]) {
        input.value = pending[field];
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
  }

  waitForApp(function() {
    console.log('[patch.js] App loaded, applying fixes...');
    window._patchApplied = true;

    // Check access status — redirect to paywall if trial expired
    fetch('/api/me', { credentials: 'include' })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.loggedIn && !data.hasAccess) {
          window.location.href = '/paywall.html';
          return;
        }
        if (data.loggedIn && data.status === 'trial' && data.trialDaysLeft <= 1) {
          // Final day warning — urgent
          var banner = document.createElement('div');
          banner.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#a8503e;color:#fff;text-align:center;padding:10px 20px;font-size:13px;font-weight:600;z-index:9999;font-family:Inter,sans-serif;';
          banner.innerHTML = '⚠️ Your free trial ends <strong>today</strong>. &nbsp;<a href="/paywall.html" style="color:#fff;text-decoration:underline;">Choose a plan now to keep access →</a>';
          document.body.appendChild(banner);
        } else if (data.loggedIn && data.status === 'trial' && data.trialDaysLeft <= 2) {
          // Day before warning — amber
          var banner = document.createElement('div');
          banner.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#c8862b;color:#fff;text-align:center;padding:10px 20px;font-size:13px;font-weight:600;z-index:9999;font-family:Inter,sans-serif;';
          banner.innerHTML = '⏰ Your free trial ends <strong>tomorrow</strong>. &nbsp;<a href="/paywall.html" style="color:#fff;text-decoration:underline;">Upgrade now to keep access →</a>';
          document.body.appendChild(banner);
        }
      }).catch(function() {});

    // Fix 1: dir=ltr on body
    document.body.setAttribute('dir', 'ltr');

    // Fix 2: Apply dir=ltr to all inputs
    function fixInputs() {
      document.querySelectorAll('input').forEach(function(input) {
        if (input.type === 'email' || input.type === 'password') return;
        if (input.getAttribute('dir') === 'ltr') return;
        input.setAttribute('dir', 'ltr');
        if (input.type === 'number') {
          input.setAttribute('type', 'text');
          input.setAttribute('inputmode', 'decimal');
        }
      });
    }
    fixInputs();

    var observer = new MutationObserver(function(mutations) {
      var hasNew = mutations.some(function(m) { return m.addedNodes.length > 0; });
      if (hasNew) {
        fixInputs();
        // Apply pending syncs when new tool inputs appear
        var tab = getActiveTab();
        if (tab) applyPendingSync(tab);
      }
    });
    observer.observe(document.getElementById('tool-container') || document.body, {
      childList: true, subtree: true, attributes: false, characterData: false
    });

    // Fix 3: Enter/Tab triggers result update (except tracker)
    document.addEventListener('keydown', function(e) {
      if (e.key !== 'Enter' && e.key !== 'Tab') return;
      var input = e.target;
      if (!input || input.tagName !== 'INPUT') return;
      if (input.closest('#login-screen')) return;
      if (getActiveTab() === 'tracker') return;
      if (e.key === 'Enter') e.preventDefault();
      clearTimeout(window._patchTimer);
      window._patchTimer = setTimeout(function() {
        var el = document.getElementById('tool-result');
        if (el && typeof window.renderResultOnly === 'function') window.renderResultOnly();
      }, 50);
    }, true);

    // Fix 4: Blur triggers result update (except tracker)
    document.addEventListener('blur', function(e) {
      var input = e.target;
      if (!input || input.tagName !== 'INPUT') return;
      if (input.closest('#login-screen')) return;
      if (getActiveTab() === 'tracker') return;
      clearTimeout(window._patchTimer);
      window._patchTimer = setTimeout(function() {
        var el = document.getElementById('tool-result');
        if (el && typeof window.renderResultOnly === 'function') window.renderResultOnly();
      }, 100);
    }, true);

    // Fix 5: Admin Panel link in sidebar
    function addAdminLink() {
      var sidebar = document.querySelector('.sidebar');
      if (!sidebar || document.getElementById('admin-link')) return;
      var link = document.createElement('a');
      link.id = 'admin-link';
      link.href = '/admin';
      link.textContent = 'Admin Panel';
      link.style.cssText = 'display:block;margin-top:12px;padding:9px 12px;border:1px solid rgba(255,255,255,0.15);border-radius:9px;color:#9aa9bb;font-size:12px;text-align:center;text-decoration:none;font-family:Inter,sans-serif;';
      link.onmouseover = function(){ this.style.color='#c9a227'; this.style.borderColor='#c9a227'; };
      link.onmouseout = function(){ this.style.color='#9aa9bb'; this.style.borderColor='rgba(255,255,255,0.15)'; };
      sidebar.appendChild(link);
    }
    addAdminLink();
    setTimeout(addAdminLink, 1000);
    setTimeout(addAdminLink, 2000);

    // Fix 6: Tracker debounce
    var trackerTimer = null;
    var origUpdateTrackerRow = window.updateTrackerRow;
    window.updateTrackerRow = function(i, field, val) {
      if (field === 'cat') { origUpdateTrackerRow(i, field, val); return; }
      var d = window.getToolData ? window.getToolData('tracker', {rows:[{name:'',amt:'',cat:'Payroll'}]}) : null;
      if (d && d.rows[i]) {
        d.rows[i][field] = val;
        if (typeof window.scheduleSave === 'function') window.scheduleSave();
      }
      clearTimeout(trackerTimer);
      trackerTimer = setTimeout(function() {
        var inputs = document.querySelectorAll('#tracker-rows input');
        var focusIdx = -1;
        inputs.forEach(function(inp, idx) { if (inp === document.activeElement) focusIdx = idx; });
        if (typeof window.renderTool === 'function') window.renderTool();
        if (focusIdx >= 0) {
          var newInputs = document.querySelectorAll('#tracker-rows input');
          if (newInputs[focusIdx]) {
            newInputs[focusIdx].focus();
            var len = newInputs[focusIdx].value.length;
            try { newInputs[focusIdx].setSelectionRange(len, len); } catch(e) {}
          }
        }
      }, 500);
    };

    // Fix 7: Flush tracker on navigation
    var origGoTo = window.goTo;
    window.goTo = function(id) {
      if (getActiveTab() === 'tracker' && trackerTimer) {
        clearTimeout(trackerTimer);
        trackerTimer = null;
        if (typeof window.renderTool === 'function') window.renderTool();
      }
      origGoTo(id);
    };

    // Fix 8: Shared field sync — hook into updateField
    var origUpdateField = window.updateField;
    window.updateField = function(tool, field, value) {
      // Call original first
      origUpdateField(tool, field, value);
      // Then sync shared fields
      var concept = getSharedConcept(tool, field);
      if (concept && value) {
        clearTimeout(window._syncTimer);
        window._syncTimer = setTimeout(function() {
          syncSharedField(concept, value, tool);
        }, 1000);
      }
    };

    // Fix 9: Add "Start Fresh" button to sidebar for monthly reset
    function addClearButton() {
      var sidebar = document.querySelector('.sidebar');
      if (!sidebar || document.getElementById('clear-btn')) return;
      var btn = document.createElement('button');
      btn.id = 'clear-btn';
      btn.textContent = 'Start Fresh (New Month)';
      btn.style.cssText = 'display:block;width:100%;margin-top:8px;padding:9px 12px;border:1px solid rgba(168,93,79,0.4);border-radius:9px;color:#a8503e;font-size:12px;text-align:center;background:none;cursor:pointer;font-family:Inter,sans-serif;';
      btn.onmouseover = function(){ this.style.borderColor='#a8503e'; this.style.background='rgba(168,93,79,0.08)'; };
      btn.onmouseout = function(){ this.style.borderColor='rgba(168,93,79,0.4)'; this.style.background='none'; };
      btn.onclick = function() {
        if (!confirm('Clear all your data and start fresh for a new month?\n\nThis cannot be undone.')) return;
        // Clear via API
        fetch('/api/data', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ data: {} })
        }).then(function() {
          // Reload the page to reset all fields
          window.location.reload();
        }).catch(function() {
          window.location.reload();
        });
      };
      sidebar.appendChild(btn);
    }
    addClearButton();
    setTimeout(addClearButton, 1000);
    setTimeout(addClearButton, 2000);

    // Fix 10: Add E-SERVICES BY MEL trademark to bottom of app
    function addTrademark() {
      if (document.getElementById('eservices-trademark')) return;
      var main = document.querySelector('.main');
      if (!main) return;
      var footer = document.createElement('div');
      footer.id = 'eservices-trademark';
      footer.style.cssText = 'margin-top:48px;padding-top:20px;border-top:1px solid var(--line);text-align:center;color:#b5a99a;font-size:11.5px;font-family:Inter,sans-serif;letter-spacing:0.06em;';
      footer.innerHTML = '&copy; ' + new Date().getFullYear() + ' <strong style="letter-spacing:0.08em;">E-SERVICES BY MEL</strong> &trade; &nbsp;|&nbsp; The Clarity Console &trade; &nbsp;|&nbsp; All rights reserved.';
      main.appendChild(footer);
    }

    // Watch for app shell becoming visible (after login)
    var trademarkObserver = new MutationObserver(function() {
      addTrademark();
    });
    trademarkObserver.observe(document.body, { childList: true, subtree: true, attributes: true });

    // Also try immediately and on delays
    addTrademark();
    setTimeout(addTrademark, 500);
    setTimeout(addTrademark, 1500);
    setTimeout(addTrademark, 3000);

    console.log('[patch.js] All fixes applied successfully.');
  });
})();

// ============================================================
// QUICKBOOKS IMPORT FEATURE
// ============================================================
(function() {

  // ---- Parser ----
  function parseQBCSV(csvText) {
    const lines = csvText.split('\n').map(l => l.trim()).filter(l => l);
    const result = { reportType: null, companyName: lines[0] ? lines[0].replace(/"/g,'') : '', data: {} };

    for (const line of lines) {
      if (/profit.*(loss|&)/i.test(line) || /income.*statement/i.test(line)) { result.reportType = 'pnl'; break; }
      if (/balance.*sheet/i.test(line)) { result.reportType = 'balance_sheet'; break; }
      if (/cash.*flow/i.test(line)) { result.reportType = 'cash_flow'; break; }
    }

    function extractNumber(str) {
      if (!str) return 0;
      const num = parseFloat(str.replace(/[",\s$()]/g, ''));
      return isNaN(num) ? 0 : Math.abs(num);
    }

    function findValue(keyword, exact) {
      for (const line of lines) {
        const cols = line.split(',');
        const label = cols[0].replace(/"/g,'').trim().toLowerCase();
        const match = exact ? label === keyword.toLowerCase() : label.includes(keyword.toLowerCase());
        if (match) {
          for (let i = cols.length - 1; i >= 1; i--) {
            const val = extractNumber(cols[i]);
            if (val > 0) return val;
          }
        }
      }
      return 0;
    }

    if (result.reportType === 'pnl') {
      const revenue = findValue('total income') || findValue('total revenue') || findValue('total sales') || findValue('gross revenue');
      const cogs = findValue('total cost of goods') || findValue('total cogs') || findValue('cost of goods sold');
      const totalExpenses = findValue('total expenses') || findValue('total operating expenses');
      const netIncome = findValue('net income', true) || findValue('net operating income') || findValue('net profit');
      const opex = totalExpenses || Math.max(0, revenue - cogs - netIncome);
      result.data = { revenue, cogs, opex, netIncome };
    }

    if (result.reportType === 'balance_sheet') {
      const cash = findValue('checking') || findValue('cash and cash') || findValue('cash', true);
      const ar = findValue('accounts receivable') || findValue('total accounts receivable');
      const ap = findValue('accounts payable') || findValue('total accounts payable');
      const totalAssets = findValue('total assets', true);
      const totalLiabilities = findValue('total liabilities', true) || findValue('total liabilities and');
      const equity = findValue('total equity', true) || findValue('net equity');
      const otherAssets = Math.max(0, totalAssets - cash - ar);
      result.data = { cash, ar, ap, totalAssets, totalLiabilities, equity, otherAssets };
    }

    if (result.reportType === 'cash_flow') {
      const operatingCash = findValue('total operating activities') || findValue('net cash from operating');
      const investingCash = findValue('total investing activities') || findValue('net cash from investing');
      const financingCash = findValue('total financing activities') || findValue('net cash from financing');
      result.data = { operatingCash, investingCash, financingCash };
    }

    return result;
  }

  // ---- Apply imported data to app fields ----
  function applyImportedData(parsed) {
    if (!parsed.reportType) return false;

    if (parsed.reportType === 'pnl') {
      var d = parsed.data;
      // Populate P&L tool
      if (typeof window.updateField === 'function') {
        window.updateField('pnl', 'revenue', String(Math.round(d.revenue)));
        window.updateField('pnl', 'cogs', String(Math.round(d.cogs)));
        window.updateField('pnl', 'opex', String(Math.round(d.opex)));
        // Also populate shared fields
        window.updateField('truth', 'revenue', String(Math.round(d.revenue)));
        window.updateField('truth', 'expenses', String(Math.round(d.opex + d.cogs)));
        window.updateField('snapshot', 'revenue', String(Math.round(d.revenue)));
        window.updateField('snapshot', 'expenses', String(Math.round(d.opex + d.cogs)));
        window.updateField('breakeven', 'fixed', String(Math.round(d.opex)));
      }
      return 'pnl';
    }

    if (parsed.reportType === 'balance_sheet') {
      var d = parsed.data;
      if (typeof window.updateField === 'function') {
        window.updateField('truth', 'bank', String(Math.round(d.cash)));
        window.updateField('truth', 'ar', String(Math.round(d.ar)));
        window.updateField('truth', 'ap', String(Math.round(d.ap)));
        window.updateField('lag', 'cash', String(Math.round(d.cash)));
        window.updateField('snapshot', 'cash', String(Math.round(d.cash)));
        window.updateField('snapshot', 'owed', String(Math.round(d.ar)));
      }
      return 'balance_sheet';
    }

    if (parsed.reportType === 'cash_flow') {
      var d = parsed.data;
      if (typeof window.updateField === 'function') {
        window.updateField('forecast', 'income', String(Math.round(Math.abs(d.operatingCash))));
      }
      return 'cash_flow';
    }

    return false;
  }

  // ---- Inject Import Button into sidebar ----
  function addImportButton() {
    if (document.getElementById('qb-import-btn')) return;
    var sidebar = document.querySelector('.sidebar');
    if (!sidebar) return;

    // Import button
    var btn = document.createElement('button');
    btn.id = 'qb-import-btn';
    btn.innerHTML = '📥 Import from QuickBooks';
    btn.style.cssText = 'display:block;width:100%;margin-top:8px;padding:9px 12px;border:1px solid rgba(200,134,43,0.4);border-radius:9px;color:#f3d9ad;font-size:12px;text-align:center;background:rgba(200,134,43,0.08);cursor:pointer;font-family:Inter,sans-serif;';
    btn.onmouseover = function(){ this.style.background='rgba(200,134,43,0.15)'; this.style.borderColor='#c8862b'; };
    btn.onmouseout = function(){ this.style.background='rgba(200,134,43,0.08)'; this.style.borderColor='rgba(200,134,43,0.4)'; };
    btn.onclick = function() { openImportModal(); };
    sidebar.appendChild(btn);
  }

  // ---- Import Modal ----
  function openImportModal() {
    // Remove existing modal
    var existing = document.getElementById('qb-import-modal');
    if (existing) existing.remove();

    var modal = document.createElement('div');
    modal.id = 'qb-import-modal';
    modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:10000;display:flex;align-items:center;justify-content:center;padding:20px;';
    modal.innerHTML = `
      <div style="background:#fff;border-radius:16px;padding:32px;max-width:520px;width:100%;box-shadow:0 24px 80px rgba(0,0,0,0.3);max-height:90vh;overflow-y:auto;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">
          <h2 style="font-family:Fraunces,serif;font-size:22px;color:#1f3148;margin:0;">Import from QuickBooks</h2>
          <button onclick="document.getElementById('qb-import-modal').remove()" style="background:none;border:none;font-size:22px;cursor:pointer;color:#9a9080;">×</button>
        </div>

        <div style="background:#f7f4ee;border-radius:10px;padding:16px;margin-bottom:20px;">
          <p style="font-size:13px;color:#4a5568;margin:0 0 10px;font-weight:600;">How to export from QuickBooks:</p>
          <ol style="font-size:13px;color:#4a5568;margin:0;padding-left:18px;line-height:1.8;">
            <li>Open QuickBooks Online or Desktop</li>
            <li>Go to <strong>Reports</strong></li>
            <li>Choose <strong>Profit & Loss</strong>, <strong>Balance Sheet</strong>, or <strong>Statement of Cash Flows</strong></li>
            <li>Set your date range</li>
            <li>Click <strong>Export</strong> → <strong>Export to CSV</strong></li>
            <li>Upload the file below</li>
          </ol>
        </div>

        <div id="qb-drop-zone" style="border:2px dashed #e3ddd0;border-radius:10px;padding:32px;text-align:center;cursor:pointer;margin-bottom:16px;transition:border-color 0.2s;">
          <div style="font-size:32px;margin-bottom:8px;">📄</div>
          <p style="font-size:15px;font-weight:600;color:#1f3148;margin:0 0 4px;">Drop your QuickBooks CSV here</p>
          <p style="font-size:13px;color:#9a9080;margin:0 0 16px;">or click to browse</p>
          <input type="file" id="qb-file-input" accept=".csv,.xlsx,.xls" style="display:none;">
          <button onclick="document.getElementById('qb-file-input').click()" style="background:#1f3148;color:#fff;border:none;padding:10px 20px;border-radius:8px;font-size:13px;cursor:pointer;font-weight:600;">Choose File</button>
        </div>

        <div id="qb-import-status" style="display:none;padding:14px;border-radius:8px;font-size:14px;margin-bottom:16px;"></div>

        <div id="qb-import-preview" style="display:none;">
          <h3 style="font-family:Fraunces,serif;font-size:16px;color:#1f3148;margin:0 0 12px;">Data found in your file:</h3>
          <div id="qb-preview-data" style="background:#f7f4ee;border-radius:8px;padding:16px;font-size:13px;color:#4a5568;line-height:1.8;"></div>
          <div style="display:flex;gap:10px;margin-top:16px;">
            <button id="qb-confirm-btn" style="flex:1;background:#1f3148;color:#fff;border:none;padding:13px;border-radius:8px;font-size:14px;font-weight:700;cursor:pointer;">✓ Import & Populate Fields</button>
            <button onclick="document.getElementById('qb-import-modal').remove()" style="background:none;border:1.5px solid #e3ddd0;color:#9a9080;padding:13px 20px;border-radius:8px;font-size:14px;cursor:pointer;">Cancel</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    // Close on backdrop click
    modal.addEventListener('click', function(e) {
      if (e.target === modal) modal.remove();
    });

    // Drag and drop
    var dropZone = document.getElementById('qb-drop-zone');
    dropZone.addEventListener('dragover', function(e) {
      e.preventDefault();
      this.style.borderColor = '#c8862b';
      this.style.background = '#fdf6eb';
    });
    dropZone.addEventListener('dragleave', function() {
      this.style.borderColor = '#e3ddd0';
      this.style.background = 'none';
    });
    dropZone.addEventListener('drop', function(e) {
      e.preventDefault();
      this.style.borderColor = '#e3ddd0';
      this.style.background = 'none';
      var file = e.dataTransfer.files[0];
      if (file) processFile(file);
    });

    // File input
    document.getElementById('qb-file-input').addEventListener('change', function() {
      if (this.files[0]) processFile(this.files[0]);
    });

    var parsedData = null;

    function showStatus(msg, type) {
      var el = document.getElementById('qb-import-status');
      el.style.display = 'block';
      el.style.background = type === 'error' ? '#f1ddd6' : type === 'success' ? '#e3ebe2' : '#f3e3c8';
      el.style.color = type === 'error' ? '#a8503e' : type === 'success' ? '#5c7a5e' : '#92611c';
      el.innerHTML = msg;
    }

    function processFile(file) {
      var reader = new FileReader();
      reader.onload = function(e) {
        var text = e.target.result;
        try {
          parsedData = parseQBCSV(text);
          if (!parsedData.reportType) {
            showStatus('⚠️ Could not detect report type. Make sure you\'re uploading a QuickBooks P&L, Balance Sheet, or Cash Flow CSV export.', 'error');
            return;
          }

          var typeLabels = { pnl: 'Profit & Loss', balance_sheet: 'Balance Sheet', cash_flow: 'Cash Flow Statement' };
          var d = parsedData.data;
          var previewHtml = '<strong>Report Type:</strong> ' + typeLabels[parsedData.reportType] + '<br>';
          if (parsedData.companyName) previewHtml += '<strong>Company:</strong> ' + parsedData.companyName + '<br><br>';

          if (parsedData.reportType === 'pnl') {
            previewHtml += '💰 <strong>Revenue:</strong> $' + Math.round(d.revenue).toLocaleString() + '<br>';
            previewHtml += '📦 <strong>Cost of Goods Sold:</strong> $' + Math.round(d.cogs).toLocaleString() + '<br>';
            previewHtml += '💼 <strong>Operating Expenses:</strong> $' + Math.round(d.opex).toLocaleString() + '<br>';
            previewHtml += '✅ <strong>Net Income:</strong> $' + Math.round(d.netIncome).toLocaleString();
          }
          if (parsedData.reportType === 'balance_sheet') {
            previewHtml += '🏦 <strong>Cash:</strong> $' + Math.round(d.cash).toLocaleString() + '<br>';
            previewHtml += '📋 <strong>Accounts Receivable:</strong> $' + Math.round(d.ar).toLocaleString() + '<br>';
            previewHtml += '💳 <strong>Accounts Payable:</strong> $' + Math.round(d.ap).toLocaleString() + '<br>';
            previewHtml += '📊 <strong>Total Assets:</strong> $' + Math.round(d.totalAssets).toLocaleString() + '<br>';
            previewHtml += '📊 <strong>Total Liabilities:</strong> $' + Math.round(d.totalLiabilities).toLocaleString() + '<br>';
            previewHtml += '✅ <strong>Equity:</strong> $' + Math.round(d.equity).toLocaleString();
          }
          if (parsedData.reportType === 'cash_flow') {
            previewHtml += '⚙️ <strong>Operating Cash Flow:</strong> $' + Math.round(d.operatingCash).toLocaleString() + '<br>';
            previewHtml += '🏗️ <strong>Investing Cash Flow:</strong> $' + Math.round(d.investingCash).toLocaleString() + '<br>';
            previewHtml += '🏦 <strong>Financing Cash Flow:</strong> $' + Math.round(d.financingCash).toLocaleString();
          }

          document.getElementById('qb-preview-data').innerHTML = previewHtml;
          document.getElementById('qb-import-preview').style.display = 'block';
          document.getElementById('qb-import-status').style.display = 'none';

          document.getElementById('qb-confirm-btn').onclick = function() {
            var type = applyImportedData(parsedData);
            if (type) {
              var toolMap = { pnl: 'pnl', balance_sheet: 'truth', cash_flow: 'forecast' };
              if (typeof window.goTo === 'function') window.goTo(toolMap[type] || 'truth');
              document.getElementById('qb-import-modal').remove();
              // Show success toast
              var toast = document.createElement('div');
              toast.style.cssText = 'position:fixed;bottom:24px;right:24px;background:#5c7a5e;color:#fff;padding:14px 20px;border-radius:10px;font-size:14px;font-weight:600;z-index:9999;box-shadow:0 8px 24px rgba(0,0,0,0.2);';
              toast.textContent = '✅ QuickBooks data imported successfully!';
              document.body.appendChild(toast);
              setTimeout(function() { toast.remove(); }, 4000);
            }
          };
        } catch(err) {
          showStatus('⚠️ Error reading file: ' + err.message, 'error');
        }
      };
      reader.readAsText(file);
    }
  }

  // Add import button when app loads
  function init() {
    if (!window._patchApplied) { setTimeout(init, 200); return; }
    addImportButton();
    setTimeout(addImportButton, 1500);
  }
  init();

})();
