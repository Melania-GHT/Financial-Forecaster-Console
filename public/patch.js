// patch.js — fixes for Clarity Console
(function() {
  'use strict';

  // Helper to get active tab from DOM (since activeTab is not on window)
  function getActiveTab() {
    var active = document.querySelector('.nav-item.active');
    if (!active) return null;
    var onclick = active.getAttribute('onclick') || '';
    var match = onclick.match(/goTo\('(\w+)'\)/);
    return match ? match[1] : null;
  }

  // Wait for app functions to be available on window
  function waitForApp(callback) {
    if (typeof window.renderTracker === 'function' && typeof window.goTo === 'function') {
      callback();
    } else {
      setTimeout(function() { waitForApp(callback); }, 100);
    }
  }

  waitForApp(function() {
    console.log('[patch.js] App loaded, applying fixes...');
    window._patchApplied = true;

    // Fix 1: dir=ltr on body
    document.body.setAttribute('dir', 'ltr');

    // Fix 2: Apply dir=ltr to all inputs (fix backwards typing)
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

    // Watch for new inputs being added (e.g. tracker rows, engine periods)
    var observer = new MutationObserver(function(mutations) {
      var hasNew = mutations.some(function(m) { return m.addedNodes.length > 0; });
      if (hasNew) fixInputs();
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

    // Fix 6: Tracker — debounce re-render during typing, restore focus after
    var trackerTimer = null;
    var origUpdateTrackerRow = window.updateTrackerRow;
    window.updateTrackerRow = function(i, field, val) {
      // Category change — re-render immediately
      if (field === 'cat') {
        origUpdateTrackerRow(i, field, val);
        return;
      }
      // Text/number — update data directly, debounce re-render
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

    // Fix 7: Flush tracker on navigation away
    var origGoTo = window.goTo;
    window.goTo = function(id) {
      if (getActiveTab() === 'tracker' && trackerTimer) {
        clearTimeout(trackerTimer);
        trackerTimer = null;
        if (typeof window.renderTool === 'function') window.renderTool();
      }
      origGoTo(id);
    };

    console.log('[patch.js] All fixes applied successfully.');
  });
})();
