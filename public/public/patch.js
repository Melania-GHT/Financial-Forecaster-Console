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
        if (data.loggedIn && data.status === 'trial' && data.trialDaysLeft <= 2) {
          // Show trial warning banner
          var banner = document.createElement('div');
          banner.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#c8862b;color:#fff;text-align:center;padding:10px 20px;font-size:13px;font-weight:600;z-index:9999;font-family:Inter,sans-serif;';
          banner.innerHTML = '⏰ Your free trial ends in <strong>' + data.trialDaysLeft + ' day' + (data.trialDaysLeft !== 1 ? 's' : '') + '</strong>. &nbsp;<a href="/paywall.html" style="color:#fff;text-decoration:underline;">Upgrade now to keep access →</a>';
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
