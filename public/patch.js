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
    document.addEventListener('keydown', function(e) {
      if (e.key !== 'Enter') return;
      var input = e.target;
      if (!input || input.tagName !== 'INPUT') return;
      // Don't intercept login form
      if (input.closest('#login-screen')) return;

      e.preventDefault();
      clearTimeout(window._patchTimer);

      var el = document.getElementById('tool-result');
      if (!el) return;
      if (typeof renderResultOnly === 'function') renderResultOnly();
    }, true);

    // Fix 3: Add dir=ltr to body
    document.body.setAttribute('dir', 'ltr');

    // Fix 4: Add dir=ltr to all existing and future inputs
    function fixInputs() {
      document.querySelectorAll('input[type="number"], input[inputmode="decimal"]').forEach(function(input) {
        input.setAttribute('dir', 'ltr');
        input.setAttribute('type', 'text');
      });
    }
    fixInputs();

    // Re-apply to new inputs as tools are navigated
    var observer = new MutationObserver(function() { fixInputs(); });
    observer.observe(document.getElementById('tool-container') || document.body, {
      childList: true, subtree: true
    });

    console.log('[patch.js] All fixes applied.');
  });
})();
