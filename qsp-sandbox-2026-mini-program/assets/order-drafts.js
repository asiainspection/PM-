/**
 * Persist incomplete booking sessions so customers can leave and resume later.
 * Shared by order-chat (save/resume) and orders (list cards).
 */
(function (global) {
  var STORAGE_KEY = 'qima-order-drafts-v1';

  function readAll() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      var data = raw ? JSON.parse(raw) : {};
      return data && typeof data === 'object' ? data : {};
    } catch (e) {
      return {};
    }
  }

  function writeAll(data) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data || {}));
    } catch (e) { /* ignore quota / private mode */ }
  }

  function list() {
    return Object.keys(readAll()).map(function (id) {
      var row = readAll()[id] || {};
      return Object.assign({ id: id }, row);
    }).sort(function (a, b) {
      return String(b.savedAt || '').localeCompare(String(a.savedAt || ''));
    });
  }

  function get(id) {
    if (!id) return null;
    var row = readAll()[id];
    return row ? Object.assign({ id: id }, row) : null;
  }

  function pad(n) { return String(n).padStart(2, '0'); }

  function formatSavedAt(iso) {
    var d = iso ? new Date(iso) : new Date();
    if (Number.isNaN(d.getTime())) d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function nextId() {
    var d = new Date();
    return 'DRF-' + d.getFullYear().toString().slice(2) +
      pad(d.getMonth() + 1) + pad(d.getDate()) +
      pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
  }

  function save(payload) {
    var id = (payload && payload.id) || nextId();
    var all = readAll();
    all[id] = {
      productName: (payload && payload.productName) || '',
      serviceKey: (payload && payload.serviceKey) || 'common.serviceLabTest',
      fields: (payload && payload.fields) ? Object.assign({}, payload.fields) : {},
      savedAt: (payload && payload.savedAt) || new Date().toISOString(),
      biz: (payload && payload.biz) || 'lab'
    };
    writeAll(all);
    return id;
  }

  function remove(id) {
    var all = readAll();
    delete all[id];
    writeAll(all);
  }

  global.OrderDrafts = {
    list: list,
    get: get,
    save: save,
    remove: remove,
    formatSavedAt: formatSavedAt,
    nextId: nextId
  };
})(window);
