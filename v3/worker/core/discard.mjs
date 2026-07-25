import {prefs, storage} from './prefs.mjs';
import {log} from './utils.mjs';

// this list keeps ids of the tabs that are in progress of being discarded
const inprogress = new Set();

const INPROGRESS_TIMEOUT_DEFAULT = 5000; // ms

const discard = tab => {
  if (!tab || typeof tab.id === 'undefined') return;
  if (inprogress.has(tab.id)) {
    return;
  }

  inprogress.add(tab.id);
  // keep id in progress for a little while to avoid duplicates
  setTimeout(() => inprogress.delete(tab.id), INPROGRESS_TIMEOUT_DEFAULT);

  if (tab.active) {
    log('tab is active', tab);
    return;
  }
  if (tab.discarded) {
    log('already discarded', tab);
    return;
  }

  return storage(prefs).then(prefs => {
    // reset count if old
    if (discard.count > prefs['simultaneous-jobs'] && discard.time + 5000 < Date.now()) {
      discard.count = 0;
    }
    if (discard.count > prefs['simultaneous-jobs']) {
      log('discarding queue for', tab);
      discard.tabs.push(tab);
      return;
    }

    return new Promise(resolve => {
      discard.count += 1;
      discard.time = Date.now();

      // re-check fresh tab state before attempting background-only discard
      try {
        chrome.tabs.get(tab.id, fresh => {
          if (!fresh) {
            log('tab not found (maybe closed)', tab.id);
            finalize();
            return;
          }

          if (fresh.active) {
            log('tab became active, skipping discard', fresh.id);
            finalize();
            return;
          }

          if (fresh.discarded) {
            log('tab already discarded', fresh.id);
            finalize();
            return;
          }

          // final candidate checks: URL scheme and pinned pref
          const url = fresh.url || '';
          if (!(url.startsWith('http') || url.startsWith('ftp'))) {
            log('not a web/ftp page, skipping', fresh.id, url);
            finalize();
            return;
          }
          if (prefs.pinned && fresh.pinned) {
            log('prefs: do not discard pinned tabs, skipping', fresh.id);
            finalize();
            return;
          }

          // perform background discard (no page injection)
          try {
            discard.perform(fresh, () => {
              finalize();
            });
          }
          catch (e) {
            log('discard.perform threw', e);
            finalize();
          }
        });
      }
      catch (e) {
        log('tabs.get failed', e);
        finalize();
      }

      function finalize() {
        discard.count -= 1;
        if (discard.tabs.length) {
          const t = discard.tabs.shift();
          inprogress.delete(t.id);
          discard(t);
        }
        resolve();
      }
    });
  });
};

// queue bookkeeping kept for compatibility
discard.tabs = [];
discard.count = 0;

// background-only discard implementation: re-checks are done by caller
// cb is optional callback invoked when discard attempt completes
discard.perform = (tab, cb) => {
  try {
    chrome.tabs.discard(tab.id, () => {
      if (chrome.runtime.lastError) {
        log('discarding failed', chrome.runtime.lastError);
      }
      else {
        log('discarded', tab.id);
      }
      if (typeof cb === 'function') cb();
    });
  }
  catch (e) {
    log('discarding failed (exception)', e);
    if (typeof cb === 'function') cb();
  }
};

export {discard, inprogress};
