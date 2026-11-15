/* Хранилище прогресса: облако Telegram (синхронизируется между устройствами) + запасная копия в localStorage.
   Значение в CloudStorage ограничено ~4096 символов, поэтому JSON режется на куски. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Store = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var CHUNK = 3000;

  /* Адаптеры: get(keys) -> Promise<{key: value}>, set(key, value) -> Promise, remove(keys) -> Promise */
  function cloudAdapter(tg) {
    var cs = tg && tg.CloudStorage;
    if (!cs || !cs.getItems) return null;
    return {
      name: "cloud",
      get: function (keys) {
        return new Promise(function (res, rej) {
          cs.getItems(keys, function (err, vals) { err ? rej(new Error(String(err))) : res(vals || {}); });
        });
      },
      set: function (k, v) {
        return new Promise(function (res, rej) {
          cs.setItem(k, v, function (err) { err ? rej(new Error(String(err))) : res(); });
        });
      },
      remove: function (keys) {
        if (!keys.length) return Promise.resolve();
        return new Promise(function (res, rej) {
          cs.removeItems(keys, function (err) { err ? rej(new Error(String(err))) : res(); });
        });
      }
    };
  }
  function localAdapter(ls) {
    try { if (!ls || !ls.getItem) return null; ls.getItem("__t"); } catch (e) { return null; }
    return {
      name: "local",
      get: function (keys) {
        var out = {};
        keys.forEach(function (k) { try { var v = ls.getItem(k); if (v != null) out[k] = v; } catch (e) {} });
        return Promise.resolve(out);
      },
      set: function (k, v) { try { ls.setItem(k, v); return Promise.resolve(); } catch (e) { return Promise.reject(e); } },
      remove: function (keys) { keys.forEach(function (k) { try { ls.removeItem(k); } catch (e) {} }); return Promise.resolve(); }
    };
  }
  function memoryAdapter(name, failing) {
    var data = {};
    return {
      name: name || "memory", data: data, failing: !!failing,
      get: function (keys) {
        if (this.failing) return Promise.reject(new Error("offline"));
        var out = {}; keys.forEach(function (k) { if (k in data) out[k] = data[k]; }); return Promise.resolve(out);
      },
      set: function (k, v) { if (this.failing) return Promise.reject(new Error("offline")); data[k] = String(v); return Promise.resolve(); },
      remove: function (keys) { keys.forEach(function (k) { delete data[k]; }); return Promise.resolve(); }
    };
  }

  function createStore(opts) {
    var adapters = (opts.adapters || []).filter(Boolean);
    var prefix = opts.prefix || "ep1";
    var delay = opts.delay == null ? 600 : opts.delay;
    var counts = {};            // адаптер -> сколько кусков записано в прошлый раз
    var timer = null, pending = null, inflight = Promise.resolve();

    function readOne(a) {
      return a.get([prefix + "_n"]).then(function (m) {
        var n = parseInt(m[prefix + "_n"], 10);
        if (!(n > 0)) return null;
        counts[a.name] = n;
        var keys = []; for (var i = 0; i < n; i++) keys.push(prefix + "_" + i);
        return a.get(keys).then(function (vals) {
          var s = ""; for (var i = 0; i < n; i++) { if (vals[keys[i]] == null) return null; s += vals[keys[i]]; }
          try { var o = JSON.parse(s); return o && typeof o === "object" ? o : null; } catch (e) { return null; }
        });
      }).catch(function () { return null; });
    }
    function load() {
      return Promise.all(adapters.map(readOne)).then(function (list) {
        var best = null;
        list.forEach(function (o) { if (o && (!best || (o.ts || 0) > (best.ts || 0))) best = o; });
        return best;
      });
    }
    function writeOne(a, json) {
      var chunks = []; for (var i = 0; i < json.length; i += CHUNK) chunks.push(json.slice(i, i + CHUNK));
      if (!chunks.length) chunks.push("");
      var seq = Promise.resolve();
      chunks.forEach(function (c, i) { seq = seq.then(function () { return a.set(prefix + "_" + i, c); }); });
      return seq.then(function () { return a.set(prefix + "_n", String(chunks.length)); }).then(function () {
        var old = counts[a.name] || 0, extra = [];
        for (var i = chunks.length; i < old; i++) extra.push(prefix + "_" + i);
        counts[a.name] = chunks.length;
        return a.remove(extra);
      });
    }
    function save(obj) {
      obj.ts = Date.now();
      var json = JSON.stringify(obj);
      inflight = inflight.then(function () {
        return Promise.all(adapters.map(function (a) { return writeOne(a, json).catch(function () { return null; }); }));
      });
      return inflight;
    }
    // Отложенное сохранение: getter вызывается в момент записи, так что берётся актуальное состояние.
    function schedule(getter) {
      pending = getter;
      if (timer) return;
      timer = setTimeout(function () { timer = null; flush(); }, delay);
    }
    function flush() {
      if (timer) { clearTimeout(timer); timer = null; }
      if (!pending) return inflight;
      var g = pending; pending = null;
      return save(g());
    }
    return { load: load, save: save, schedule: schedule, flush: flush };
  }

  return { createStore: createStore, cloudAdapter: cloudAdapter, localAdapter: localAdapter, memoryAdapter: memoryAdapter, CHUNK: CHUNK };
});
