// patch.js — fixes result updates without requiring full index.html replacement
// Loaded after the main app script

(function() {
  'use strict';

  // Wait for app to fully initialize
  function waitForApp(callback) {
    if (typeof updateField === 'function' && typeof renderResultOnly === 'function') {
      callback();
    } else {
      setTimeout(function() { waitForApp(callback); }, 100);
    }
  }

  waitForApp(function() {
    console.log('[patch.js] App loaded, applying fixes...');

    // Fix 1: Override updateField to trigger result updates after typing pauses
    var originalUpdateField = window.updateField;
    window.updateField = function(tool, field, value) {
      if (!window.currentData[tool]) window.currentData[tool] = {};
      window.currentData[tool][field] = value;

      // Schedule result update after typing pauses
      clearTimeout(window._patchTimer);
      window._patchTimer = setTimeout(function() {
        var el = document.getElementById('tool-result');
        if (!el) return;
        if (typeof renderResultOnly === 'function') renderResultOnly();
      }, 400);

      // Also trigger save
      if (typeof scheduleSave === 'function') scheduleSave();
    };

    // Fix 2: Add Enter key handler to all tool inputs
    // Also handle Tab leaving an input field
    document.addEventListener('keydown', function(e) {
      if (e.key !== 'Enter' && e.key !== 'Tab') return;
      var input = e.target;
      if (!input || input.tagName !== 'INPUT') return;
      if (input.closest('#login-screen')) return;
      // Skip tracker — Tab should move between fields normally, not trigger re-render
      if (window.activeTab === 'tracker') return;

      if (e.key === 'Enter') e.preventDefault();
      clearTimeout(window._patchTimer);

      setTimeout(function() {
        var el = document.getElementById('tool-result');
        if (!el) return;
        if (typeof renderResultOnly === 'function') renderResultOnly();
      }, 50);
    }, true);

    // Fix 3: Add dir=ltr to body
    document.body.setAttribute('dir', 'ltr');

    // Fix 4: Add dir=ltr to all existing and future inputs
    function fixInputs() {
      document.querySelectorAll('input').forEach(function(input) {
        if (input.type === 'email' || input.type === 'password') return;
        if (input.getAttribute('dir') === 'ltr') return; // already fixed, skip
        input.setAttribute('dir', 'ltr');
        if (input.type === 'number') {
          input.setAttribute('type', 'text');
          input.setAttribute('inputmode', 'decimal');
        }
      });
    }
    fixInputs();

    // Only re-run fixInputs when new child elements are added (not on attribute changes)
    var observer = new MutationObserver(function(mutations) {
      for (var i = 0; i < mutations.length; i++) {
        if (mutations[i].addedNodes.length > 0) {
          fixInputs();
          break;
        }
      }
    });
    observer.observe(document.getElementById('tool-container') || document.body, {
      childList: true,
      subtree: true,
      attributes: false,
      characterData: false
    });

    // Fix 5: Update results when focus leaves any input field
    document.addEventListener('blur', function(e) {
      var input = e.target;
      if (!input || input.tagName !== 'INPUT') return;
      if (input.closest('#login-screen')) return;
      // Skip tracker — it has its own update logic
      if (window.activeTab === 'tracker') return;
      clearTimeout(window._patchTimer);
      window._patchTimer = setTimeout(function() {
        var el = document.getElementById('tool-result');
        if (!el) return;
        if (typeof renderResultOnly === 'function') renderResultOnly();
      }, 100);
    }, true);

    // Fix 6: Add Admin link to sidebar
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
    // Try immediately and also after app loads
    addAdminLink();
    setTimeout(addAdminLink, 1000);
    setTimeout(addAdminLink, 2000);

    // Fix 7: Tracker row updates — save data immediately, only update summary on pause
    var trackerTimer = null;
    window.updateTrackerRow = function(i, field, val) {
      if (!window.currentData['tracker']) window.currentData['tracker'] = {rows:[{name:'',amt:'',cat:'Payroll'}]};
      var d = window.currentData['tracker'];
      if (!d.rows[i]) return;
      d.rows[i][field] = val;
      if (typeof scheduleSave === 'function') scheduleSave();

      if (field === 'name' || field === 'amt') {
        // Don't re-render rows — just update the spending summary after pause
        clearTimeout(trackerTimer);
        trackerTimer = setTimeout(function() {
          updateTrackerSummary(d);
        }, 300);
      } else {
        // Category dropdown — re-render immediately (no typing involved)
        if (typeof renderTool === 'function') renderTool();
      }
    };

    // Updates only the spending summary without touching the input rows
    function updateTrackerSummary(d) {
      var rows = d.rows || [];
      var totals = {};
      var grand = 0;
      rows.forEach(function(r) {
        var amt = Number(r.amt) || 0;
        if (amt <= 0) return;
        totals[r.cat] = (totals[r.cat] || 0) + amt;
        grand += amt;
      });
      var sorted = Object.entries(totals).sort(function(a,b){ return b[1]-a[1]; });
      // Find the result div inside the tracker card
      var resultEl = document.querySelector('#tool-container .result');
      if (grand <= 0) {
        if (resultEl) resultEl.style.display = 'none';
        return;
      }
      var fmt = function(n){ return '$' + Math.abs(Number(n)||0).toLocaleString(undefined,{maximumFractionDigits:0}); };
      var html = '<h3 style="margin-top:0;">Your top spending categories</h3>' +
        '<table><thead><tr><th>Category</th><th>Total</th><th>% of spend</th></tr></thead><tbody>' +
        sorted.map(function(e){ return '<tr><td>'+e[0]+'</td><td>'+fmt(e[1])+'</td><td>'+(e[1]/grand*100).toFixed(0)+'%</td></tr>'; }).join('') +
        '</tbody></table>' +
        '<p class="story" style="margin-top:16px;">You spent '+fmt(grand)+' total. '+sorted[0][0]+' was your single biggest category at '+fmt(sorted[0][1])+' ('+(sorted[0][1]/grand*100).toFixed(0)+'%).</p>';
      if (resultEl) {
        resultEl.innerHTML = html;
        resultEl.style.display = '';
      } else {
        // No result div yet — do a full render
        if (typeof renderTool === 'function') renderTool();
      }
    }

    console.log('[patch.js] All fixes applied.');
  });
})();
