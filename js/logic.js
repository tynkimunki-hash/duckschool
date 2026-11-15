/* Чистая логика приложения: без DOM и без Telegram, поэтому её можно тестировать в Node.
   В браузере доступна как глобальный объект Logic. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Logic = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ---------- Правила (единое место настройки) ---------- */
  var RULES = {
    PASS_MIN: 4,            // из 6 заданий темы (3 вопроса + 3 задачи)
    DAILY_Q: 5,
    DAILY_T: 5,
    EXAM_Q: 10,
    EXAM_T: 10,
    EXAM_MINUTES: 45,
    FREEZES_FREE: 1,        // заморозок в месяц: восстанавливают серию после пропуска
    FREEZES_PREMIUM: 3,
    FREEZE_GAP_FREE: 3,     // самый длинный пропуск (в днях), который заморозка может закрыть
    FREEZE_GAP_PREMIUM: 14,
    EXAM_COOLDOWN_DAYS: 7,  // бесплатный экзамен на предмет: через 7 дней после прошлого
    ELECTIVE_CHANGE_DAYS: 14, // бесплатный предмет по выбору можно сменить не чаще раза в 14 дней
    STREAK_MODES: { easy: { n: 1, title: "Лёгкий" }, medium: { n: 2, title: "Средний" }, hard: { n: 3, title: "Хард" } },
    LATEST_SHARE: 0.6,      // доля заданий про последнюю тему в обычный день
    REVIEW_WEEKDAY: 0       // 0 = воскресенье: день повторения
  };

  /* ---------- Даты ---------- */
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function ymd(d) { d = d || new Date(); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function ymdToUTC(s) { var p = s.split("-"); return Date.UTC(+p[0], +p[1] - 1, +p[2]); }
  function daysBetween(a, b) { return Math.round((ymdToUTC(b) - ymdToUTC(a)) / 86400000); }
  function isoWeekKey(d) {
    d = d || new Date();
    var t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    var day = t.getUTCDay() || 7;
    t.setUTCDate(t.getUTCDate() + 4 - day);
    var y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    var week = Math.ceil(((t - y0) / 86400000 + 1) / 7);
    return t.getUTCFullYear() + "-W" + pad(week);
  }

  /* ---------- ГСЧ с зерном ---------- */
  function hashSeed(str) {
    var h = 1779033703 ^ str.length;
    for (var i = 0; i < str.length; i++) {
      h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^ (h >>> 16)) >>> 0;
  }
  function rng(seedStr) {
    var a = hashSeed(String(seedStr));
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function shuffled(arr, rand) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(rand() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /* ---------- Проверка ответов на задачи ---------- */
  function normalizeText(s) {
    return String(s == null ? "" : s).toLowerCase()
      .replace(/ё/g, "е")
      .replace(/[−–—]/g, "-")
      .replace(/\*\*/g, "^")
      .replace(/[«»"“”']/g, "")
      .replace(/\s+/g, "")
      .replace(/[.;]+$/, "");
  }
  function stripVarPrefix(s) {            // «x=6» -> «6»
    return s.replace(/^[a-zа-я]\d?=/, "");
  }
  function parseNumber(s) {
    s = normalizeText(s);
    s = stripVarPrefix(s).replace(/[%°]$/, "").replace(",", ".");
    if (/^[+-]?\d+(\.\d+)?$/.test(s)) return parseFloat(s);
    var m = /^([+-]?\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/.exec(s);
    if (m && parseFloat(m[2]) !== 0) return parseFloat(m[1]) / parseFloat(m[2]);
    return null;
  }
  function splitSet(s) {
    return String(s).split(/;|\s+и\s+|,(?=\s|-|$)|\s+/).map(function (x) { return x.trim(); }).filter(Boolean);
  }
  function sameNumber(a, b) { return Math.abs(a - b) < 1e-9 * Math.max(1, Math.abs(a), Math.abs(b)); }

  function checkTask(task, input) {
    if (input == null || String(input).trim() === "") return false;
    var type = task.type || "number";
    if (type === "set") {
      var want = (Array.isArray(task.answer) ? task.answer : splitSet(task.answer)).map(parseNumber);
      if (want.some(function (x) { return x === null; })) return false;
      var got = splitSet(input).map(parseNumber);
      if (got.some(function (x) { return x === null; })) return false;
      var uniq = function (arr) {
        var out = [];
        arr.slice().sort(function (a, b) { return a - b; }).forEach(function (x) {
          if (!out.length || !sameNumber(out[out.length - 1], x)) out.push(x);
        });
        return out;
      };
      var w = uniq(want), g = uniq(got);
      return w.length === g.length && w.every(function (x, i) { return sameNumber(x, g[i]); });
    }
    var variants = [task.answer].concat(task.accept || []);
    if (type === "number") {
      var v = parseNumber(input);
      if (v !== null) {
        return variants.some(function (a) { var n = parseNumber(a); return n !== null && sameNumber(n, v); });
      }
    }
    var ni = stripVarPrefix(normalizeText(input));
    return variants.some(function (a) { return stripVarPrefix(normalizeText(a)) === ni; });
  }
  function formatAnswer(task) {
    return Array.isArray(task.answer) ? task.answer.join("; ") : String(task.answer);
  }

  /* ---------- Подготовка тем ---------- */
  // Раскладывает тему в плоские списки заданий с устойчивыми ключами.
  function flattenTopic(topic) {
    var qs = [], ts = [];
    function add(list, arr, prefix, kind) {
      (arr || []).forEach(function (d, i) {
        list.push({ key: topic.id + ":" + prefix + "." + kind + i, topicId: topic.id, kind: kind === "q" ? "q" : "t", data: d });
      });
    }
    add(qs, topic.practice && topic.practice.questions, "p", "q");
    add(ts, topic.practice && topic.practice.tasks, "p", "t");
    (topic.exams || []).forEach(function (ex, v) {
      add(qs, ex.questions, "e" + v, "q");
      add(ts, ex.tasks, "e" + v, "t");
    });
    return { questions: qs, tasks: ts };
  }
  function practiceItems(topic) {
    var out = [];
    ((topic.practice && topic.practice.questions) || []).forEach(function (d, i) {
      out.push({ key: topic.id + ":p.q" + i, topicId: topic.id, kind: "q", data: d });
    });
    ((topic.practice && topic.practice.tasks) || []).forEach(function (d, i) {
      out.push({ key: topic.id + ":p.t" + i, topicId: topic.id, kind: "t", data: d });
    });
    return out;
  }
  function examItems(topic, attempt) {
    var exams = topic.exams || [];
    if (!exams.length) return [];
    var v = ((attempt || 0) % exams.length + exams.length) % exams.length;
    var ex = exams[v], out = [];
    (ex.questions || []).slice(0, RULES.EXAM_Q).forEach(function (d, i) {
      out.push({ key: topic.id + ":e" + v + ".q" + i, topicId: topic.id, kind: "q", data: d });
    });
    (ex.tasks || []).slice(0, RULES.EXAM_T).forEach(function (d, i) {
      out.push({ key: topic.id + ":e" + v + ".t" + i, topicId: topic.id, kind: "t", data: d });
    });
    return out;
  }
  // Экзамен по всему предмету: случайные задания из пройденных тем.
  function subjectExamItems(topics, seed) {
    var rand = rng(seed), qs = [], ts = [];
    topics.forEach(function (t) {
      var f = flattenTopic(t);
      qs = qs.concat(f.questions); ts = ts.concat(f.tasks);
    });
    return shuffled(qs, rand).slice(0, RULES.EXAM_Q).concat(shuffled(ts, rand).slice(0, RULES.EXAM_T));
  }

  /* ---------- Ежедневные задания ---------- */
  function weightedPick(pool, errors, rand, used) {
    var cand = pool.filter(function (e) { return !used[e.key]; });
    if (!cand.length) return null;
    var weights = cand.map(function (e) { return 1 + 3 * Math.min(errors[e.key] || 0, 3); });
    var total = weights.reduce(function (a, b) { return a + b; }, 0);
    var r = rand() * total;
    for (var i = 0; i < cand.length; i++) { r -= weights[i]; if (r <= 0) return cand[i]; }
    return cand[cand.length - 1];
  }
  // learned: [{id, passedAt, pool:{questions,tasks}}] — только пройденные темы.
  function pickDaily(opts) {
    var learned = (opts.learned || []).slice().sort(function (a, b) { return (a.passedAt || 0) - (b.passedAt || 0); });
    if (!learned.length) return { needLearn: true, items: [], mode: "none" };
    var rand = rng(opts.seed), errors = opts.errors || {};
    var latest = learned[learned.length - 1], older = learned.slice(0, -1);
    var review = !!opts.review;
    var mode = review ? "review" : "regular";
    var olderOrAll = older.length ? older : learned;       // единственная тема — повторяем её
    var items = [];
    [["q", RULES.DAILY_Q], ["t", RULES.DAILY_T]].forEach(function (pair) {
      var kind = pair[0], n = pair[1], used = {};
      var poolOf = function (topics) {
        var out = [];
        topics.forEach(function (t) { out = out.concat(kind === "q" ? t.pool.questions : t.pool.tasks); });
        return out;
      };
      var latestPool = poolOf([latest]), olderPool = poolOf(olderOrAll);
      for (var i = 0; i < n; i++) {
        var fromLatest = !review && (older.length === 0 || rand() < RULES.LATEST_SHARE);
        var first = fromLatest ? latestPool : olderPool;
        var second = fromLatest ? olderPool : latestPool;
        var pick = weightedPick(first, errors, rand, used) || weightedPick(second, errors, rand, used);
        if (!pick) break;
        used[pick.key] = true;
        items.push(pick);
      }
    });
    return { needLearn: false, items: items, mode: mode };
  }
  function isReviewDay(d) { return (d || new Date()).getDay() === RULES.REVIEW_WEEKDAY; }

  /* ---------- Стрик: заморозки раз в месяц ---------- */
  function monthKey(today) { return String(today).slice(0, 7); }
  function freezeGap(isPremium) { return isPremium ? RULES.FREEZE_GAP_PREMIUM : RULES.FREEZE_GAP_FREE; }
  function freezesPerMonth(isPremium) { return isPremium ? RULES.FREEZES_PREMIUM : RULES.FREEZES_FREE; }
  function normStreak(st) {
    st = st || {};
    return { count: st.count || 0, best: st.best || 0, last: st.last || null, fm: st.fm || null, fu: st.fu || 0, lf: st.lf || null };
  }
  function freezesLeft(streak, today, isPremium) {
    var used = streak && streak.fm === monthKey(today) ? (streak.fu || 0) : 0;
    return Math.max(0, freezesPerMonth(isPremium) - used);
  }
  function missedDays(streak, today) { return streak.last ? Math.max(0, daysBetween(streak.last, today) - 1) : 0; }
  // ok — серия идёт; saveable — пропуск закроет заморозка (серия восстановится, когда пройдёшь задания); lost — сгорела
  function streakStatus(streak, today, isPremium) {
    var s = normStreak(streak), missed = missedDays(s, today);
    if (!s.count || !s.last || missed === 0) return "ok";
    if (missed <= freezeGap(isPremium) && freezesLeft(s, today, isPremium) > 0) return "saveable";
    return "lost";
  }
  // Заранее ничего не сжигаем: судьба серии решается, когда человек проходит задания (или показывается как «сгорела»).
  function settleStreak(streak) { return normStreak(streak); }
  function streakInfo(streak, today, isPremium) {
    var s = normStreak(streak), status = streakStatus(s, today, isPremium);
    return {
      count: status === "lost" ? 0 : s.count, best: s.best, status: status, missed: missedDays(s, today),
      freezesLeft: freezesLeft(s, today, isPremium), freezesTotal: freezesPerMonth(isPremium),
      gap: freezeGap(isPremium), doneToday: s.last === today
    };
  }
  function completeDay(streak, today, isPremium) {
    var s = normStreak(streak);
    if (s.last === today) return s;
    var status = streakStatus(s, today, isPremium);
    if (status === "saveable") {
      if (s.fm !== monthKey(today)) { s.fm = monthKey(today); s.fu = 0; }
      s.fu++; s.lf = today;                       // lf: день, когда заморозка спасла серию
    } else if (status === "lost") s.count = 0;
    s.count++; s.last = today;
    if (s.count > s.best) s.best = s.count;
    return s;
  }

  /* ---------- Коды (подпись Ed25519) ---------- */
  function b64urlToBytes(str) {
    var b64 = str.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    if (typeof atob === "function") {
      var bin = atob(b64), out = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    return new Uint8Array(Buffer.from(b64, "base64"));
  }
  function bytesToString(bytes) {
    if (typeof TextDecoder !== "undefined") return new TextDecoder().decode(bytes);
    return Buffer.from(bytes).toString("utf8");
  }
  // code = base64url(payload).base64url(signature)
  function verifyCode(code, publicKeyB64u, nacl, userId, nowSec) {
    try {
      code = String(code || "").trim();
      var parts = code.split(".");
      if (parts.length !== 2) return { ok: false, reason: "format" };
      var payloadBytes = b64urlToBytes(parts[0]), sig = b64urlToBytes(parts[1]);
      var pub = b64urlToBytes(publicKeyB64u);
      if (sig.length !== 64 || pub.length !== 32) return { ok: false, reason: "format" };
      if (!nacl.sign.detached.verify(payloadBytes, sig, pub)) return { ok: false, reason: "signature" };
      var p = JSON.parse(bytesToString(payloadBytes));
      if (p.v !== 1) return { ok: false, reason: "version" };
      if (Number(p.u) !== Number(userId)) return { ok: false, reason: "user" };
      if (p.k === "p" && !(p.e > nowSec)) return { ok: false, reason: "expired", payload: p };
      if (["p", "s", "c"].indexOf(p.k) < 0) return { ok: false, reason: "kind" };
      return { ok: true, payload: p };
    } catch (e) {
      return { ok: false, reason: "format" };
    }
  }
  function computeEntitlements(codes, publicKeyB64u, nacl, userId, nowSec) {
    var ent = { premiumUntil: 0, subjects: {}, career: [] };
    (codes || []).forEach(function (c) {
      var r = verifyCode(c, publicKeyB64u, nacl, userId, nowSec);
      if (!r.ok) return;
      var p = r.payload;
      if (p.k === "p") ent.premiumUntil = Math.max(ent.premiumUntil, p.e);
      else if (p.k === "s" && p.s) ent.subjects[p.s] = true;
      else if (p.k === "c" && p.n) ent.career.push(p.n);
    });
    return ent;
  }
  function isPremium(ent, nowSec) { return ent.premiumUntil > nowSec; }

  /* ---------- Доступ к предметам ---------- */
  // tier: free | elective | paid
  function subjectAccess(subject, state, ent, nowSec) {
    if (isPremium(ent, nowSec)) return "open";
    if (subject.tier === "free") return "open";
    if (ent.subjects[subject.id]) return "open";
    if (subject.tier === "elective" && state.elective === subject.id) return "open";
    if (subject.tier === "elective" && !state.elective) return "choose";   // можно выбрать бесплатно
    return "locked";
  }
  // Бесплатно: 1 экзамен на предмет, следующий — через 7 дней после прошлого. state.exams[предмет] = время (мс) прошлого экзамена.
  function nextExamAt(state, subjectId) {
    var last = Number((state.exams || {})[subjectId]);
    return last > 0 ? last + RULES.EXAM_COOLDOWN_DAYS * 86400000 : 0;
  }
  function canTakeExam(state, subjectId, premium, nowMs) {
    if (premium) return true;
    return nowMs >= nextExamAt(state, subjectId);
  }
  // Бесплатный предмет по выбору: сменить можно через 14 дней после выбора (или сразу открыть нужный за звёзды).
  function electiveChangeAt(state) { return state.electiveAt > 0 ? state.electiveAt + RULES.ELECTIVE_CHANGE_DAYS * 86400000 : 0; }
  function canChangeElective(state, nowMs) { return nowMs >= electiveChangeAt(state); }

  /* ---------- Профориентация ---------- */
  var CAREER_TYPES = ["R", "I", "A", "S", "E", "C"];
  function scoreCareer(items, answers) {
    var sum = {}, max = {}, cnt = {};
    CAREER_TYPES.forEach(function (t) { sum[t] = 0; max[t] = 0; cnt[t] = 0; });
    items.forEach(function (it, i) {
      max[it.t] += 5; cnt[it.t]++;
      var a = answers[i];
      if (a >= 1 && a <= 5) sum[it.t] += a;
    });
    var pct = {};
    CAREER_TYPES.forEach(function (t) { pct[t] = max[t] ? Math.round(sum[t] / max[t] * 100) : 0; });
    var order = CAREER_TYPES.slice().sort(function (a, b) { return pct[b] - pct[a] || CAREER_TYPES.indexOf(a) - CAREER_TYPES.indexOf(b); });
    return { sum: sum, max: max, pct: pct, top: order.slice(0, 3), order: order };
  }
  function encodeAnswers(answers, n) {
    var s = "";
    for (var i = 0; i < n; i++) s += (answers[i] >= 1 && answers[i] <= 5) ? String(answers[i]) : "0";
    return s;
  }
  function decodeAnswers(s) { return s.split("").map(Number); }

  /* ---------- Безопасный вывод текста ---------- */
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  // Минимальная разметка: **жирный**, `код`, списки «- », переносы строк.
  function renderRich(text) {
    var lines = esc(text).split("\n"), out = [], inList = false;
    lines.forEach(function (ln) {
      var m = /^\s*[-•]\s+(.*)$/.exec(ln);
      if (m) { if (!inList) { out.push("<ul>"); inList = true; } out.push("<li>" + inline(m[1]) + "</li>"); return; }
      if (inList) { out.push("</ul>"); inList = false; }
      if (ln.trim() === "") out.push("<br>"); else out.push("<p>" + inline(ln) + "</p>");
    });
    if (inList) out.push("</ul>");
    return out.join("");
    function inline(s) {
      return s.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`(.+?)`/g, "<code>$1</code>");
    }
  }

  /* ---------- Начальное состояние ---------- */
  function defaultState() {
    return {
      v: 1, ts: 0,
      elective: null,
      electiveAt: 0,                      // когда выбран бесплатный предмет (мс)
      topics: {},                         // id -> {passed, best, attempts, passedAt}
      errors: {},                         // key -> число ошибок
      exams: {},                          // subject -> время последнего бесплатного экзамена (мс)
      examAttempts: {},                   // topicId -> число попыток
      streak: { count: 0, best: 0, last: null, fm: null, fu: 0, lf: null },   // fm/fu: месяц и число использованных заморозок
      streakMode: "easy",                 // easy / medium / hard: сколько предметов нужно для стрика (1/2/3)
      streakSubjects: ["algebra"],
      daily: {},                          // YYYY-MM-DD -> {subject: {done, score}}
      career: { free: { a: [] }, paid: { a: [], nonce: null }, usedNonces: [] },
      codes: []
    };
  }
  function pruneState(st, today) {
    var keys = Object.keys(st.daily).sort();
    while (keys.length > 14) delete st.daily[keys.shift()];
    var ek = Object.keys(st.errors);
    if (ek.length > 600) {
      ek.sort(function (a, b) { return st.errors[a] - st.errors[b]; }).slice(0, ek.length - 600).forEach(function (k) { delete st.errors[k]; });
    }
    return st;
  }

  return {
    RULES: RULES, ymd: ymd, daysBetween: daysBetween, isoWeekKey: isoWeekKey,
    rng: rng, shuffled: shuffled,
    normalizeText: normalizeText, parseNumber: parseNumber, checkTask: checkTask, formatAnswer: formatAnswer,
    flattenTopic: flattenTopic, practiceItems: practiceItems, examItems: examItems, subjectExamItems: subjectExamItems,
    pickDaily: pickDaily, isReviewDay: isReviewDay,
    freezeGap: freezeGap, freezesPerMonth: freezesPerMonth, freezesLeft: freezesLeft, streakStatus: streakStatus,
    settleStreak: settleStreak, streakInfo: streakInfo, completeDay: completeDay,
    verifyCode: verifyCode, computeEntitlements: computeEntitlements, isPremium: isPremium,
    subjectAccess: subjectAccess, canTakeExam: canTakeExam, nextExamAt: nextExamAt,
    electiveChangeAt: electiveChangeAt, canChangeElective: canChangeElective,
    CAREER_TYPES: CAREER_TYPES, scoreCareer: scoreCareer, encodeAnswers: encodeAnswers, decodeAnswers: decodeAnswers,
    esc: esc, renderRich: renderRich, defaultState: defaultState, pruneState: pruneState
  };
});
