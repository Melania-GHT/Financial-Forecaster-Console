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
        setTimeout(function(){ if(window._injectCharts) window._injectCharts(); }, 400);
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
        setTimeout(function(){ if(window._injectCharts) window._injectCharts(); }, 400);
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

// ============================================================
// CHARTS & DATA VISUALIZATIONS
// ============================================================
(function() {

  // Local copy of getActiveTab for this scope
  function getActiveTab() {
    var active = document.querySelector('.nav-item.active');
    if (!active) return null;
    var onclick = active.getAttribute('onclick') || '';
    var match = onclick.match(/goTo\('(\w+)'\)/);
    return match ? match[1] : null;
  }
  var C = {
    navy:    '#1f3148',
    amber:   '#c8862b',
    sage:    '#5c7a5e',
    rust:    '#a8503e',
    paper:   '#f7f4ee',
    line:    '#e3ddd0',
    ink:     '#1b2430',
    inkSoft: '#4a5568',
    good:    '#5c7a5e',
    watch:   '#c8862b',
    danger:  '#a8503e',
  };

  // ---- SVG helpers ----
  function svg(w, h, content, extraStyle) {
    return '<svg viewBox="0 0 ' + w + ' ' + h + '" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;' + (extraStyle||'') + '">' + content + '</svg>';
  }

  function fmt(n) {
    var num = Math.abs(Number(n) || 0);
    if (num >= 1000000) return '$' + (num/1000000).toFixed(1) + 'M';
    if (num >= 1000) return '$' + (num/1000).toFixed(0) + 'K';
    return '$' + num.toLocaleString(undefined, {maximumFractionDigits:0});
  }

  // ---- 1. PIE CHART — Money Tracker spending breakdown ----
  function renderSpendingPie(data) {
    var rows = (data && data.rows) || [];
    var totals = {};
    var grand = 0;
    rows.forEach(function(r) {
      var amt = Number(r.amt) || 0;
      if (amt > 0 && r.name) { totals[r.cat || 'Other'] = (totals[r.cat || 'Other'] || 0) + amt; grand += amt; }
    });
    if (grand <= 0) return '';
    var colors = [C.navy, C.amber, C.sage, C.rust, '#7c6d8a', '#4a7c8a', '#8a6d4a', '#6d8a4a'];
    var entries = Object.entries(totals).sort(function(a,b){return b[1]-a[1];});
    var cx = 100, cy = 100, r = 80;
    var slices = '';
    var legend = '';
    var angle = -Math.PI/2;
    entries.forEach(function(e, i) {
      var pct = e[1]/grand;
      var sweep = pct * 2 * Math.PI;
      var x1 = cx + r*Math.cos(angle);
      var y1 = cy + r*Math.sin(angle);
      var x2 = cx + r*Math.cos(angle+sweep);
      var y2 = cy + r*Math.sin(angle+sweep);
      var large = sweep > Math.PI ? 1 : 0;
      var color = colors[i % colors.length];
      slices += '<path d="M'+cx+','+cy+' L'+x1+','+y1+' A'+r+','+r+' 0 '+large+',1 '+x2+','+y2+' Z" fill="'+color+'" stroke="white" stroke-width="2"/>';
      // Label on slice if large enough
      if (pct > 0.08) {
        var midAngle = angle + sweep/2;
        var lx = cx + (r*0.65)*Math.cos(midAngle);
        var ly = cy + (r*0.65)*Math.sin(midAngle);
        slices += '<text x="'+lx+'" y="'+ly+'" text-anchor="middle" dominant-baseline="middle" fill="white" font-size="9" font-weight="700">'+Math.round(pct*100)+'%</text>';
      }
      legend += '<rect x="220" y="'+(20+i*22)+'" width="12" height="12" rx="2" fill="'+color+'"/>'
        + '<text x="238" y="'+(31+i*22)+'" font-size="11" fill="'+C.inkSoft+'">'+e[0]+'</text>'
        + '<text x="360" y="'+(31+i*22)+'" text-anchor="end" font-size="11" font-weight="700" fill="'+C.ink+'">'+fmt(e[1])+'</text>';
      angle += sweep;
    });
    // Center total
    slices += '<circle cx="'+cx+'" cy="'+cy+'" r="36" fill="white"/>';
    slices += '<text x="'+cx+'" y="'+(cy-8)+'" text-anchor="middle" font-size="9" fill="'+C.inkSoft+'">Total</text>';
    slices += '<text x="'+cx+'" y="'+(cy+8)+'" text-anchor="middle" font-size="13" font-weight="700" fill="'+C.ink+'">'+fmt(grand)+'</text>';
    return svg(380, 200+Math.max(0,(entries.length-6)*22), slices+legend);
  }

  // ---- 2. GAUGE — Profit Margin ----
  function renderProfitGauge(revenue, netIncome) {
    if (!revenue || revenue <= 0) return '';
    var margin = (netIncome / revenue) * 100;
    var clamped = Math.max(-30, Math.min(40, margin));
    // Map -30..40 to 0..180 degrees
    var angleDeg = ((clamped + 30) / 70) * 180;
    var angleRad = (angleDeg - 180) * Math.PI / 180;
    var cx = 130, cy = 110, r = 90;
    var nx = cx + r * Math.cos(angleRad);
    var ny = cy + r * Math.sin(angleRad);
    var status = margin >= 15 ? 'Healthy' : margin >= 5 ? 'Watch' : 'Danger';
    var statusColor = margin >= 15 ? C.good : margin >= 5 ? C.watch : C.danger;
    var content = ''
      // Background arc segments
      + '<path d="M '+(cx-r)+','+cy+' A '+r+','+r+' 0 0,1 '+(cx+r)+','+cy+'" fill="none" stroke="'+C.line+'" stroke-width="20"/>'
      // Danger zone (0-20%)
      + '<path d="M '+(cx-r)+','+cy+' A '+r+','+r+' 0 0,1 '+(cx + r*Math.cos(-Math.PI + 0.571))+','+(cy + r*Math.sin(-Math.PI + 0.571))+'" fill="none" stroke="'+C.rust+'" stroke-width="20" opacity="0.3"/>'
      // Watch zone (20-50%)
      + '<path d="M '+(cx + r*Math.cos(-Math.PI + 0.571))+','+(cy + r*Math.sin(-Math.PI + 0.571))+' A '+r+','+r+' 0 0,1 '+(cx + r*Math.cos(-Math.PI + 1.571))+','+(cy + r*Math.sin(-Math.PI + 1.571))+'" fill="none" stroke="'+C.amber+'" stroke-width="20" opacity="0.3"/>'
      // Good zone (50-100%)
      + '<path d="M '+(cx + r*Math.cos(-Math.PI + 1.571))+','+(cy + r*Math.sin(-Math.PI + 1.571))+' A '+r+','+r+' 0 0,1 '+(cx+r)+','+cy+'" fill="none" stroke="'+C.sage+'" stroke-width="20" opacity="0.3"/>'
      // Needle
      + '<line x1="'+cx+'" y1="'+cy+'" x2="'+nx+'" y2="'+ny+'" stroke="'+C.navy+'" stroke-width="3" stroke-linecap="round"/>'
      + '<circle cx="'+cx+'" cy="'+cy+'" r="6" fill="'+C.navy+'"/>'
      // Labels
      + '<text x="'+(cx-r-8)+'" y="'+(cy+20)+'" text-anchor="middle" font-size="9" fill="'+C.inkSoft+'">Loss</text>'
      + '<text x="'+cx+'" y="'+(cy-r-12)+'" text-anchor="middle" font-size="9" fill="'+C.inkSoft+'">15%</text>'
      + '<text x="'+(cx+r+8)+'" y="'+(cy+20)+'" text-anchor="middle" font-size="9" fill="'+C.inkSoft+'">40%</text>'
      // Value
      + '<text x="'+cx+'" y="'+(cy+28)+'" text-anchor="middle" font-size="22" font-weight="700" fill="'+statusColor+'">'+margin.toFixed(1)+'%</text>'
      + '<text x="'+cx+'" y="'+(cy+44)+'" text-anchor="middle" font-size="11" fill="'+statusColor+'" font-weight="700">'+status+'</text>'
      + '<text x="'+cx+'" y="'+(cy+60)+'" text-anchor="middle" font-size="9" fill="'+C.inkSoft+'">Profit Margin</text>';
    return svg(260, 160, content);
  }

  // ---- 3. BAR CHART — Revenue vs Expenses ----
  function renderRevenueExpensesBar(revenue, expenses, netIncome) {
    if (!revenue && !expenses) return '';
    var max = Math.max(revenue, expenses, 1);
    var barW = 60, gap = 30, h = 160, padL = 50, padB = 30, padT = 20;
    var scaleH = h - padB - padT;
    var rH = Math.round((revenue/max) * scaleH);
    var eH = Math.round((expenses/max) * scaleH);
    var nColor = netIncome >= 0 ? C.good : C.danger;
    var content = ''
      // Y axis
      + '<line x1="'+padL+'" y1="'+padT+'" x2="'+padL+'" y2="'+(h-padB)+'" stroke="'+C.line+'" stroke-width="1"/>'
      // Revenue bar
      + '<rect x="'+(padL+gap)+'" y="'+(h-padB-rH)+'" width="'+barW+'" height="'+rH+'" fill="'+C.navy+'" rx="4"/>'
      + '<text x="'+(padL+gap+barW/2)+'" y="'+(h-padB-rH-6)+'" text-anchor="middle" font-size="10" font-weight="700" fill="'+C.navy+'">'+fmt(revenue)+'</text>'
      + '<text x="'+(padL+gap+barW/2)+'" y="'+(h-padB+14)+'" text-anchor="middle" font-size="10" fill="'+C.inkSoft+'">Revenue</text>'
      // Expenses bar
      + '<rect x="'+(padL+gap*2+barW)+'" y="'+(h-padB-eH)+'" width="'+barW+'" height="'+eH+'" fill="'+C.rust+'" rx="4" opacity="0.8"/>'
      + '<text x="'+(padL+gap*2+barW+barW/2)+'" y="'+(h-padB-eH-6)+'" text-anchor="middle" font-size="10" font-weight="700" fill="'+C.rust+'">'+fmt(expenses)+'</text>'
      + '<text x="'+(padL+gap*2+barW+barW/2)+'" y="'+(h-padB+14)+'" text-anchor="middle" font-size="10" fill="'+C.inkSoft+'">Expenses</text>'
      // Net income label
      + '<text x="'+(padL+gap*3+barW*2+20)+'" y="'+(h/2)+'" text-anchor="middle" font-size="10" fill="'+C.inkSoft+'">Net</text>'
      + '<text x="'+(padL+gap*3+barW*2+20)+'" y="'+(h/2+16)+'" text-anchor="middle" font-size="14" font-weight="700" fill="'+nColor+'">'+fmt(netIncome)+'</text>'
      // Baseline
      + '<line x1="'+padL+'" y1="'+(h-padB)+'" x2="260" y2="'+(h-padB)+'" stroke="'+C.line+'" stroke-width="1"/>';
    return svg(260, h, content);
  }

  // ---- 4. LINE CHART — 90-day cash forecast ----
  function renderForecastLine(cash, monthlyIncome, monthlyExpenses) {
    if (!cash && !monthlyIncome) return '';
    var months = 4;
    var points = [];
    var current = Number(cash) || 0;
    var income = Number(monthlyIncome) || 0;
    var expenses = Number(monthlyExpenses) || 0;
    for (var i = 0; i <= months; i++) {
      points.push(current + (income - expenses) * i);
    }
    var minV = Math.min.apply(null, points);
    var maxV = Math.max.apply(null, points);
    var range = Math.max(maxV - minV, 1);
    var w = 280, h = 140, padL = 55, padR = 15, padT = 15, padB = 30;
    var chartW = w - padL - padR;
    var chartH = h - padT - padB;
    var coords = points.map(function(v, i) {
      var x = padL + (i/months)*chartW;
      var y = padT + chartH - ((v-minV)/range)*chartH;
      return x+','+y;
    });
    var color = points[months] >= points[0] ? C.sage : C.rust;
    var content = ''
      // Zero line if applicable
      + (minV < 0 ? '<line x1="'+padL+'" y1="'+(padT+chartH-((0-minV)/range)*chartH)+'" x2="'+(w-padR)+'" y2="'+(padT+chartH-((0-minV)/range)*chartH)+'" stroke="'+C.rust+'" stroke-width="1" stroke-dasharray="4,2" opacity="0.5"/>' : '')
      // Area fill
      + '<polyline points="'+coords.join(' ')+'" fill="none" stroke="'+color+'" stroke-width="2.5" stroke-linejoin="round"/>'
      // Points
      + points.map(function(v,i){
          var x = padL + (i/months)*chartW;
          var y = padT + chartH - ((v-minV)/range)*chartH;
          return '<circle cx="'+x+'" cy="'+y+'" r="4" fill="'+color+'" stroke="white" stroke-width="1.5"/>'
            + '<text x="'+x+'" y="'+(y-10)+'" text-anchor="middle" font-size="9" fill="'+color+'" font-weight="700">'+fmt(v)+'</text>';
        }).join('')
      // X axis labels
      + ['Now','30d','60d','90d','4mo'].map(function(l,i){
          var x = padL + (i/months)*chartW;
          return '<text x="'+x+'" y="'+(h-padB+14)+'" text-anchor="middle" font-size="9" fill="'+C.inkSoft+'">'+l+'</text>';
        }).join('')
      // Y axis
      + '<line x1="'+padL+'" y1="'+padT+'" x2="'+padL+'" y2="'+(h-padB)+'" stroke="'+C.line+'" stroke-width="1"/>'
      + '<line x1="'+padL+'" y1="'+(h-padB)+'" x2="'+(w-padR)+'" y2="'+(h-padB)+'" stroke="'+C.line+'" stroke-width="1"/>'
      + '<text x="10" y="'+(padT+chartH/2)+'" text-anchor="middle" font-size="9" fill="'+C.inkSoft+'" transform="rotate(-90,10,'+(padT+chartH/2)+')">Cash</text>';
    return svg(w, h, content);
  }

  // ---- 5. BREAK-EVEN PROGRESS BAR ----
  function renderBreakevenBar(revenue, fixedCosts, grossMarginPct) {
    if (!fixedCosts || !grossMarginPct) return '';
    var breakeven = fixedCosts / (grossMarginPct/100);
    var pct = Math.min(1, revenue/breakeven);
    var color = pct >= 1 ? C.good : pct >= 0.7 ? C.watch : C.danger;
    var w = 280, bH = 20;
    var content = ''
      + '<text x="0" y="14" font-size="11" fill="'+C.inkSoft+'">Break-even Progress</text>'
      + '<rect x="0" y="22" width="'+w+'" height="'+bH+'" rx="10" fill="'+C.line+'"/>'
      + '<rect x="0" y="22" width="'+(pct*w)+'" height="'+bH+'" rx="10" fill="'+color+'"/>'
      + '<text x="'+(pct*w+6)+'" y="37" font-size="10" fill="'+color+'" font-weight="700">'+Math.round(pct*100)+'%</text>'
      + '<text x="0" y="58" font-size="10" fill="'+C.inkSoft+'">Target: '+fmt(breakeven)+'</text>'
      + '<text x="'+w+'" y="58" text-anchor="end" font-size="10" fill="'+C.ink+'" font-weight="700">Current: '+fmt(revenue)+'</text>'
      + (pct >= 1
        ? '<text x="'+(w/2)+'" y="80" text-anchor="middle" font-size="11" fill="'+C.good+'" font-weight="700">✓ Above break-even — you\'re profitable</text>'
        : '<text x="'+(w/2)+'" y="80" text-anchor="middle" font-size="11" fill="'+C.rust+'">Need '+fmt(breakeven-revenue)+' more to break even</text>');
    return svg(w, 88, content);
  }

  // ---- 6. FINANCIAL HEALTH SCORE ----
  function getFieldValue(tool, key) {
    var input = document.querySelector('.tool-input[data-tool="'+tool+'"][data-key="'+key+'"]');
    return input ? Number(input.value) || 0 : 0;
  }

  function calcHealthScore() {
    var rev  = getFieldValue('truth','revenue') || getFieldValue('pnl','revenue');
    var exp  = getFieldValue('truth','expenses') || getFieldValue('pnl','opex');
    var bank = getFieldValue('truth','bank');
    var ar   = getFieldValue('truth','ar');
    var ap   = getFieldValue('truth','ap');
    var cogs = getFieldValue('pnl','cogs');
    var score = 0;
    var factors = [];
    var hasData = rev > 0 || bank > 0;

    if (!hasData) {
      return { score: 0, grade: 'No Data', color: C.line, factors: [{text: 'Enter your numbers above to see your score', positive: false}] };
    }

    // Factor 1: Profit margin (0-35 points)
    if (rev > 0) {
      var margin = ((rev - exp - cogs) / rev) * 100;
      if (margin >= 25) { score += 35; factors.push({text: 'Excellent profit margin ('+margin.toFixed(0)+'%)', positive: true}); }
      else if (margin >= 15) { score += 28; factors.push({text: 'Strong profit margin ('+margin.toFixed(0)+'%)', positive: true}); }
      else if (margin >= 8) { score += 20; factors.push({text: 'Healthy profit margin ('+margin.toFixed(0)+'%)', positive: true}); }
      else if (margin >= 0) { score += 10; factors.push({text: 'Thin profit margin ('+margin.toFixed(0)+'%) — room to improve', positive: false}); }
      else { score += 0; factors.push({text: 'Negative margin ('+margin.toFixed(0)+'%) — expenses exceed revenue', positive: false}); }
    } else { score += 15; }

    // Factor 2: Cash runway (0-30 points)
    if (bank > 0 && exp > 0) {
      var runway = bank / (exp / 30);
      if (runway >= 180) { score += 30; factors.push({text: 'Excellent cash runway ('+Math.round(runway/30)+' months)', positive: true}); }
      else if (runway >= 90) { score += 24; factors.push({text: 'Strong cash runway ('+Math.round(runway)+' days)', positive: true}); }
      else if (runway >= 45) { score += 16; factors.push({text: 'Adequate cash runway ('+Math.round(runway)+' days)', positive: true}); }
      else if (runway >= 20) { score += 8; factors.push({text: 'Low cash runway ('+Math.round(runway)+' days) — monitor closely', positive: false}); }
      else { score += 0; factors.push({text: 'Critical cash runway ('+Math.round(runway)+' days) — act now', positive: false}); }
    } else if (bank > 0) { score += 20; }

    // Factor 3: Receivables vs Payables (0-20 points)
    if (ar > 0 || ap > 0) {
      var ratio = ap > 0 ? ar / ap : 2;
      if (ratio >= 2) { score += 20; factors.push({text: 'Strong: you\'re owed 2x more than you owe', positive: true}); }
      else if (ratio >= 1) { score += 14; factors.push({text: 'Healthy: more owed to you than you owe', positive: true}); }
      else if (ratio >= 0.5) { score += 7; factors.push({text: 'Watch: payables are catching up to receivables', positive: false}); }
      else { score += 0; factors.push({text: 'High payables vs receivables — cash pressure ahead', positive: false}); }
    } else { score += 14; }

    // Factor 4: Revenue covers costs (0-15 points)
    if (rev > 0 && (exp > 0 || cogs > 0)) {
      var totalCosts = exp + cogs;
      var coverageRatio = rev / Math.max(totalCosts, 1);
      if (coverageRatio >= 1.3) { score += 15; factors.push({text: 'Revenue is 30%+ above total costs', positive: true}); }
      else if (coverageRatio >= 1.1) { score += 10; factors.push({text: 'Revenue comfortably covers costs', positive: true}); }
      else if (coverageRatio >= 1.0) { score += 5; factors.push({text: 'Revenue just covers costs — thin cushion', positive: false}); }
      else { score += 0; factors.push({text: 'Revenue not covering total costs', positive: false}); }
    }

    score = Math.max(0, Math.min(100, score));
    var grade, color;
    if (score >= 85) { grade = 'Excellent'; color = C.good; }
    else if (score >= 70) { grade = 'Good'; color = C.sage; }
    else if (score >= 55) { grade = 'Fair'; color = C.watch; }
    else if (score >= 35) { grade = 'Needs Attention'; color = C.amber; }
    else { grade = 'Critical'; color = C.danger; }

    return { score: score, grade: grade, color: color, factors: factors.slice(0,4) };
  }


  function renderHealthScore(health) {
    var s = health.score;
    var circumference = 2 * Math.PI * 45;
    var dashOffset = circumference * (1 - s/100);
    var content = ''
      + '<circle cx="60" cy="60" r="45" fill="none" stroke="'+C.line+'" stroke-width="10"/>'
      + '<circle cx="60" cy="60" r="45" fill="none" stroke="'+health.color+'" stroke-width="10" stroke-linecap="round"'
      + ' stroke-dasharray="'+circumference+'" stroke-dashoffset="'+dashOffset+'"'
      + ' transform="rotate(-90 60 60)"/>'
      + '<text x="60" y="55" text-anchor="middle" font-size="22" font-weight="700" fill="'+health.color+'">'+s+'</text>'
      + '<text x="60" y="72" text-anchor="middle" font-size="10" fill="'+C.inkSoft+'">/100</text>'
      + '<text x="140" y="20" font-size="16" font-weight="700" fill="'+health.color+'">'+health.grade+'</text>'
      + health.factors.map(function(f, i) {
          return '<text x="140" y="'+(38+i*18)+'" font-size="10" fill="'+(f.positive ? C.good : C.rust)+'">'
            + (f.positive ? '✓ ' : '⚠ ') + f.text + '</text>';
        }).join('');
    return svg(320, 120, content);
  }

  // ---- 7. RUNWAY CALCULATOR ----
  function renderRunway(bank, monthlyExpenses) {
    if (!bank || !monthlyExpenses) return '';
    var months = bank / monthlyExpenses;
    var color = months >= 6 ? C.good : months >= 3 ? C.watch : C.danger;
    var label = months >= 6 ? 'Strong runway' : months >= 3 ? 'Monitor closely' : 'Low runway — act now';
    var bars = Math.min(12, Math.round(months));
    var content = '<text x="0" y="14" font-size="11" fill="'+C.inkSoft+'">Cash Runway</text>';
    for (var i = 0; i < 12; i++) {
      var filled = i < bars;
      content += '<rect x="'+(i*22)+'" y="22" width="18" height="28" rx="3" fill="'+(filled ? color : C.line)+'"/>';
    }
    content += '<text x="0" y="68" font-size="18" font-weight="700" fill="'+color+'">'+months.toFixed(1)+' months</text>'
      + '<text x="0" y="84" font-size="11" fill="'+color+'" font-weight="600">'+label+'</text>'
      + '<text x="264" y="84" text-anchor="end" font-size="10" fill="'+C.inkSoft+'">at '+fmt(monthlyExpenses)+'/mo</text>';
    return svg(264, 92, content);
  }

  // ---- 8. MONTH-OVER-MONTH COMPARISON ----
  function renderMoMComparison(current, previous, label) {
    if (!current && !previous) return '';
    var change = previous > 0 ? ((current-previous)/previous)*100 : 0;
    var positive = current >= previous;
    var arrow = positive ? '▲' : '▼';
    var color = positive ? C.good : C.danger;
    var content = ''
      + '<text x="140" y="16" text-anchor="middle" font-size="11" fill="'+C.inkSoft+'">'+label+'</text>'
      + '<text x="70" y="50" text-anchor="middle" font-size="22" font-weight="700" fill="'+C.ink+'">'+fmt(current)+'</text>'
      + '<text x="70" y="65" text-anchor="middle" font-size="10" fill="'+C.inkSoft+'">This month</text>'
      + '<text x="140" y="46" text-anchor="middle" font-size="16" fill="'+color+'">'+arrow+'</text>'
      + '<text x="140" y="62" text-anchor="middle" font-size="11" font-weight="700" fill="'+color+'">'+Math.abs(change).toFixed(1)+'%</text>'
      + '<text x="210" y="50" text-anchor="middle" font-size="22" font-weight="700" fill="'+C.inkSoft+'">'+fmt(previous)+'</text>'
      + '<text x="210" y="65" text-anchor="middle" font-size="10" fill="'+C.inkSoft+'">Last month</text>'
      + '<line x1="0" y1="75" x2="280" y2="75" stroke="'+C.line+'" stroke-width="1"/>';
    return svg(280, 82, content);
  }

  // ---- 9. WHAT-IF SCENARIOS ----
  function renderWhatIf(revenue, expenses, cogs) {
    if (!revenue) return '';
    var currentProfit = revenue - expenses - cogs;
    var scenarios = [
      { label: 'Price +10%', rev: revenue*1.1, exp: expenses, cogs: cogs },
      { label: 'Price +20%', rev: revenue*1.2, exp: expenses, cogs: cogs },
      { label: 'Costs -10%', rev: revenue, exp: expenses*0.9, cogs: cogs },
      { label: 'Both +10%', rev: revenue*1.1, exp: expenses*0.9, cogs: cogs },
    ];
    var maxP = Math.max.apply(null, scenarios.map(function(s){return s.rev-s.exp-s.cogs;}));
    var minP = Math.min(currentProfit, 0);
    var range = Math.max(maxP - minP, 1);
    var barW = 44, gap = 12, padL = 50, padT = 15, padB = 30, h = 140;
    var chartH = h - padT - padB;
    var zeroY = padT + chartH - ((0-minP)/range)*chartH;
    var content = ''
      + '<line x1="'+padL+'" y1="'+zeroY+'" x2="'+(padL+scenarios.length*(barW+gap))+'" y2="'+zeroY+'" stroke="'+C.line+'" stroke-width="1" stroke-dasharray="4,2"/>'
      + '<text x="'+padL+'" y="'+(zeroY-4)+'" font-size="8" fill="'+C.inkSoft+'">$0</text>'
      // Current bar
      + '<rect x="0" y="'+(padT + chartH - ((currentProfit-minP)/range)*chartH)+'" width="'+(padL-4)+'" height="'+((currentProfit-minP)/range*chartH)+'" fill="'+C.navy+'" rx="2" opacity="0.5"/>'
      + '<text x="'+(padL/2)+'" y="'+(h-padB+14)+'" text-anchor="middle" font-size="9" fill="'+C.inkSoft+'">Now</text>'
      + '<text x="'+(padL/2)+'" y="'+(padT+chartH-((currentProfit-minP)/range)*chartH-4)+'" text-anchor="middle" font-size="8" fill="'+C.navy+'">'+fmt(currentProfit)+'</text>';
    scenarios.forEach(function(s, i) {
      var profit = s.rev - s.exp - s.cogs;
      var bH = Math.abs((profit-minP)/range*chartH);
      var by = padT + chartH - ((profit-minP)/range*chartH);
      var color = profit >= currentProfit ? C.sage : C.rust;
      var x = padL + i*(barW+gap);
      content += '<rect x="'+x+'" y="'+by+'" width="'+barW+'" height="'+bH+'" fill="'+color+'" rx="2" opacity="0.7"/>'
        + '<text x="'+(x+barW/2)+'" y="'+(by-4)+'" text-anchor="middle" font-size="8" fill="'+color+'" font-weight="700">'+fmt(profit)+'</text>'
        + '<text x="'+(x+barW/2)+'" y="'+(h-padB+14)+'" text-anchor="middle" font-size="9" fill="'+C.inkSoft+'">'+s.label+'</text>';
    });
    return svg(padL + scenarios.length*(barW+gap) + 10, h, content);
  }

  // ---- Inject charts into tool result panels ----
  function injectCharts() {
    var tab = getActiveTab();
    if (tab === 'tracker') {
      var resultEl = document.querySelector('#tool-container .result');
      if (resultEl && !resultEl.querySelector('.chart-injected')) {
        var trackerData = window.currentData && window.currentData.tracker ? window.currentData.tracker : null;
        var chartDiv = document.createElement('div');
        chartDiv.className = 'chart-injected';
        chartDiv.style.cssText = 'margin-top:20px;padding-top:16px;border-top:1px solid #e3ddd0;';
        chartDiv.innerHTML = '<div style="font-size:12px;color:#9a9080;text-transform:uppercase;letter-spacing:0.06em;font-weight:700;margin-bottom:12px;">Spending Breakdown</div>'
          + renderSpendingPie(trackerData);
        resultEl.appendChild(chartDiv);
      }
    }

    if (tab === 'pnl') {
      var resultEl = document.getElementById('tool-result');
      if (resultEl && resultEl.innerHTML && !resultEl.querySelector('.chart-injected')) {
        var rev = getFieldValue('pnl','revenue');
        var cogs = getFieldValue('pnl','cogs');
        var opex = getFieldValue('pnl','opex');
        var net = rev - cogs - opex;
        var chartDiv = document.createElement('div');
        chartDiv.className = 'chart-injected';
        chartDiv.style.cssText = 'margin-top:20px;display:grid;grid-template-columns:1fr 1fr;gap:16px;';
        chartDiv.innerHTML = '<div><div style="font-size:11px;color:#9a9080;text-transform:uppercase;letter-spacing:0.06em;font-weight:700;margin-bottom:8px;">Revenue vs Expenses</div>'+renderRevenueExpensesBar(rev, opex+cogs, net)+'</div>'
          + '<div><div style="font-size:11px;color:#9a9080;text-transform:uppercase;letter-spacing:0.06em;font-weight:700;margin-bottom:8px;">Profit Margin</div>'+renderProfitGauge(rev, net)+'</div>';
        resultEl.appendChild(chartDiv);
      }
    }

    if (tab === 'truth') {
      var resultEl = document.getElementById('tool-result');
      if (resultEl && resultEl.innerHTML && !resultEl.querySelector('.chart-injected')) {
        var health = calcHealthScore();
        var bank = getFieldValue('truth','bank');
        var exp  = getFieldValue('truth','expenses');
        var chartDiv = document.createElement('div');
        chartDiv.className = 'chart-injected';
        chartDiv.style.cssText = 'margin-top:20px;';
        chartDiv.innerHTML = '<div style="font-size:11px;color:#9a9080;text-transform:uppercase;letter-spacing:0.06em;font-weight:700;margin-bottom:8px;">Financial Health Score</div>'
          + renderHealthScore(health)
          + '<div style="margin-top:16px;"><div style="font-size:11px;color:#9a9080;text-transform:uppercase;letter-spacing:0.06em;font-weight:700;margin-bottom:8px;">Cash Runway</div>'
          + renderRunway(bank, exp) + '</div>';
        resultEl.appendChild(chartDiv);
      }
    }

    if (tab === 'breakeven') {
      var resultEl = document.getElementById('tool-result');
      if (resultEl && resultEl.innerHTML && !resultEl.querySelector('.chart-injected')) {
        var fixed = getFieldValue('breakeven','fixed');
        var price = getFieldValue('breakeven','price');
        var cost  = getFieldValue('breakeven','cost');
        var rev   = getFieldValue('pnl','revenue') || getFieldValue('truth','revenue');
        var gm = price > 0 ? ((price-cost)/price)*100 : 60;
        var chartDiv = document.createElement('div');
        chartDiv.className = 'chart-injected';
        chartDiv.style.cssText = 'margin-top:20px;';
        var beContent = renderBreakevenBar(rev, fixed, gm);
        if (beContent) {
          chartDiv.innerHTML = '<div style="font-size:11px;color:#9a9080;text-transform:uppercase;letter-spacing:0.06em;font-weight:700;margin-bottom:8px;">Break-Even Progress</div>' + beContent;
          resultEl.appendChild(chartDiv);
        }
      }
    }

    if (tab === 'forecast') {
      var resultEl = document.getElementById('tool-result');
      if (resultEl && resultEl.innerHTML && !resultEl.querySelector('.chart-injected')) {
        var bank   = getFieldValue('truth','bank');
        var income = getFieldValue('forecast','income');
        var expF   = getFieldValue('forecast','expenses');
        var chartDiv = document.createElement('div');
        chartDiv.className = 'chart-injected';
        chartDiv.style.cssText = 'margin-top:20px;';
        var fcContent = renderForecastLine(bank, income, expF);
        if (fcContent) {
          chartDiv.innerHTML = '<div style="font-size:11px;color:#9a9080;text-transform:uppercase;letter-spacing:0.06em;font-weight:700;margin-bottom:8px;">90-Day Cash Forecast</div>' + fcContent;
          // What-if scenarios
          var rev  = getFieldValue('pnl','revenue') || getFieldValue('truth','revenue');
          var exp  = getFieldValue('pnl','opex') || getFieldValue('truth','expenses');
          var cogs = getFieldValue('pnl','cogs');
          if (rev > 0) {
            chartDiv.innerHTML += '<div style="margin-top:16px;"><div style="font-size:11px;color:#9a9080;text-transform:uppercase;letter-spacing:0.06em;font-weight:700;margin-bottom:8px;">What-If Scenarios</div>'
              + renderWhatIf(rev, exp, cogs) + '</div>';
          }
          resultEl.appendChild(chartDiv);
        }
      }
    }

    if (tab === 'snapshot') {
      var resultEl = document.getElementById('tool-result');
      if (resultEl && resultEl.innerHTML && !resultEl.querySelector('.chart-injected')) {
        var rev = getFieldValue('snapshot','revenue') || getFieldValue('truth','revenue');
        var exp = getFieldValue('snapshot','expenses') || getFieldValue('truth','expenses');
        var chartDiv = document.createElement('div');
        chartDiv.className = 'chart-injected';
        chartDiv.style.cssText = 'margin-top:20px;';
        if (rev > 0) {
          chartDiv.innerHTML = '<div style="font-size:11px;color:#9a9080;text-transform:uppercase;letter-spacing:0.06em;font-weight:700;margin-bottom:8px;">Revenue vs Expenses</div>'
            + renderRevenueExpensesBar(rev, exp, rev-exp);
          resultEl.appendChild(chartDiv);
        }
      }
    }
  }

  // Expose injectCharts globally so it can be called from patch
  window._injectCharts = injectCharts;

  // Watch for result panel updates and inject charts
  function watchForResults() {
    if (!window._patchApplied) { setTimeout(watchForResults, 200); return; }
    var toolContainer = document.getElementById('tool-container');
    if (!toolContainer) { setTimeout(watchForResults, 200); return; }
    var chartObserver = new MutationObserver(function(mutations) {
      var hasNew = mutations.some(function(m) { return m.addedNodes.length > 0 || m.type === 'characterData'; });
      if (hasNew) setTimeout(injectCharts, 300);
    });
    chartObserver.observe(toolContainer, { childList: true, subtree: true, characterData: true });

    // Also hook into renderResultOnly if available
    var origRenderResultOnly = window.renderResultOnly;
    if (typeof origRenderResultOnly === 'function') {
      window.renderResultOnly = function() {
        origRenderResultOnly();
        setTimeout(injectCharts, 200);
      };
    }

    // Hook into renderResultFromWorker if available
    var origRenderFromWorker = window.renderResultFromWorker;
    if (typeof origRenderFromWorker === 'function') {
      window.renderResultFromWorker = function(result) {
        origRenderFromWorker(result);
        setTimeout(injectCharts, 200);
      };
    }

    console.log('[charts] Chart system initialized');
  }
  watchForResults();

})();
