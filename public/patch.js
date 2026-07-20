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

    // Fix 7: Prevent tracker from re-rendering on every keystroke
    var trackerRenderTimer = null;
    window.updateTrackerRow = function(i, field, val) {
      // Update data immediately
      if (!window.currentData.tracker) window.currentData.tracker = {rows:[{name:'',amt:'',cat:'Payroll'}]};
      if (window.currentData.tracker.rows[i]) {
        window.currentData.tracker.rows[i][field] = val;
      }
      if (typeof scheduleSave === 'function') scheduleSave();

      // Category dropdown — re-render immediately
      if (field === 'cat') {
        clearTimeout(trackerRenderTimer);
        if (typeof renderTool === 'function') renderTool();
        return;
      }

      // Text/number fields — debounce re-render, restore focus after
      clearTimeout(trackerRenderTimer);
      trackerRenderTimer = setTimeout(function() {
        // Find which input has focus and its position among all tracker inputs
        var trackerInputs = document.querySelectorAll('#tracker-rows input');
        var focusedIndex = -1;
        trackerInputs.forEach(function(inp, idx) {
          if (inp === document.activeElement) focusedIndex = idx;
        });

        if (typeof renderTool === 'function') renderTool();

        // Restore focus to the same input position after re-render
        if (focusedIndex >= 0) {
          var newInputs = document.querySelectorAll('#tracker-rows input');
          if (newInputs[focusedIndex]) {
            newInputs[focusedIndex].focus();
            var len = newInputs[focusedIndex].value.length;
            try { newInputs[focusedIndex].setSelectionRange(len, len); } catch(e){}
          }
        }
      }, 500);
    };

    // Fix 8: Flush tracker data when navigating away from the tracker
    var originalGoTo = window.goTo;
    window.goTo = function(id) {
      // If leaving tracker, flush any pending re-render immediately
      if (window.activeTab === 'tracker' && trackerRenderTimer) {
        clearTimeout(trackerRenderTimer);
        trackerRenderTimer = null;
        // Update the spending summary before navigating
        if (typeof renderTool === 'function') renderTool();
      }
      if (typeof originalGoTo === 'function') originalGoTo(id);
    };

    console.log('[patch.js] All fixes applied.');
  });
})();
