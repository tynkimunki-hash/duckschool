/* Интерфейс мини-приложения. Вся логика правил — в logic.js, хранение — в store.js. */
(function () {
  "use strict";
  var L = window.Logic, S = window.Store, CFG = window.APP_CONFIG || {};
  var tg = window.Telegram && window.Telegram.WebApp;
  var $app = document.getElementById("app");
  var esc = L.esc;

  /* ---------- Состояние ---------- */
  var state = L.defaultState();
  var catalog = { subjects: [] };
  var indexes = {};              // subjectId -> {topics:[...], demo} | null
  var topicCache = {};           // topicId -> данные темы
  var ent = { premiumUntil: 0, subjects: {}, career: [] };
  var careerData = null;         // {free, paid, types}
  var store = null;
  var nav = [];
  var run = null;
  var timerId = null;
  var uid = 0;

  var authDate = 0;   // время запуска от Telegram: часы телефона не могут «откатить» премиум назад
  function nowSec() { return Math.max(Math.floor(Date.now() / 1000), authDate); }
  function nowMs() { return nowSec() * 1000; }
  function fmtDate(ms) { return new Date(ms).toLocaleDateString("ru-RU", { day: "numeric", month: "long" }); }
  function isPrem() { return L.isPremium(ent, nowSec()); }
  function today() { return L.ymd(new Date()); }
  function save() { state.ts = Date.now(); if (store) store.schedule(function () { return state; }); }
  function subj(id) { return catalog.subjects.filter(function (s) { return s.id === id; })[0]; }
  function access(s) { return L.subjectAccess(s, state, ent, nowSec()); }
  function ready(s) { return !!(indexes[s.id] && indexes[s.id].topics && indexes[s.id].topics.length); }
  function topicsOf(sid) { return (indexes[sid] && indexes[sid].topics || []).slice().sort(function (a, b) { return (a.order || 0) - (b.order || 0); }); }
  function passedTopics(sid) { return topicsOf(sid).filter(function (t) { return state.topics[t.id] && state.topics[t.id].passed; }); }
  function plural(n, a, b, c) { n = Math.abs(n) % 100; var m = n % 10; if (n > 10 && n < 20) return c; if (m > 1 && m < 5) return b; if (m === 1) return a; return c; }

  function applyTheme() {
    var dark = false;
    try { dark = tg && tg.colorScheme ? tg.colorScheme === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches; } catch (e) {}
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  }

  /* ---------- Утилиты интерфейса ---------- */
  function toast(msg) {
    var t = document.getElementById("toast");
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.hidden = true; }, 2600);
  }
  function haptic(kind) { try { tg && tg.HapticFeedback && tg.HapticFeedback.notificationOccurred(kind); } catch (e) {} }
  function confirmBox(text) {
    return new Promise(function (res) {
      if (tg && tg.showConfirm) { try { tg.showConfirm(text, res); return; } catch (e) {} }
      res(window.confirm(text));
    });
  }
  function fetchJSON(url) {
    return fetch(url, { cache: "no-cache" }).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); });
  }
  function openBot(param) {
    var url = "https://t.me/" + (CFG.BOT_USERNAME || "") + "?start=" + encodeURIComponent(param);
    if (tg && tg.openTelegramLink) { tg.openTelegramLink(url); setTimeout(function () { try { tg.close(); } catch (e) {} }, 350); }
    else window.open(url, "_blank");
  }
  function stopTimer() { if (timerId) { clearInterval(timerId); timerId = null; } }
  function setHtml(html) { $app.innerHTML = html; window.scrollTo(0, 0); }

  /* ---------- Навигация ---------- */
  function go(fn, arg) { nav.push({ fn: fn, arg: arg }); fn(arg); syncBack(); }
  function goHome() { stopTimer(); run = null; nav = []; renderHome(); syncBack(); }
  function back() {
    stopTimer(); run = null;
    nav.pop();
    var cur = nav[nav.length - 1];
    if (!cur) return goHome();
    cur.fn(cur.arg); syncBack();
  }
  function syncBack() {
    if (!tg || !tg.BackButton) return;
    try { if (nav.length > 0) tg.BackButton.show(); else tg.BackButton.hide(); } catch (e) {}
  }
  function reshow() { var cur = nav[nav.length - 1]; if (cur) cur.fn(cur.arg); else goHome(); }
  function backBtn() { return '<button class="back" data-a="back">← Назад</button>'; }

  /* ---------- Загрузка тем ---------- */
  function loadTopic(sid, tid) {
    if (topicCache[tid]) return Promise.resolve(topicCache[tid]);
    var meta = topicsOf(sid).filter(function (t) { return t.id === tid; })[0];
    var file = (meta && meta.file) || ("data/" + sid + "/" + tid + ".json");
    return fetchJSON(file).then(function (t) { t.id = t.id || tid; topicCache[tid] = t; return t; });
  }
  function learnedPools(sid) {
    var list = passedTopics(sid);
    return Promise.all(list.map(function (m) { return loadTopic(sid, m.id).catch(function () { return null; }); })).then(function (ts) {
      var out = [];
      ts.forEach(function (t, i) {
        if (!t) return;
        out.push({ id: t.id, passedAt: state.topics[t.id].passedAt || 0, pool: L.flattenTopic(t), topic: t });
      });
      return out;
    });
  }

  /* ---------- Коды ---------- */
  function recomputeEnt() {
    ent = L.computeEntitlements(state.codes, CFG.PUBLIC_KEY || "", window.nacl, uid, nowSec());
  }
  function addCode(code) {
    code = String(code || "").trim();
    if (!code) return { ok: false, msg: "Вставьте код." };
    if (!CFG.PUBLIC_KEY) return { ok: false, msg: "Приложение ещё не настроено (нет публичного ключа)." };
    var r = L.verifyCode(code, CFG.PUBLIC_KEY, window.nacl, uid, nowSec());
    if (!r.ok) {
      var why = { user: "Этот код выдан другому аккаунту.", expired: "Срок этого кода истёк.", signature: "Код не подходит.", format: "Код не распознан." }[r.reason] || "Код не подходит.";
      return { ok: false, msg: why };
    }
    if (state.codes.indexOf(code) >= 0) return { ok: true, msg: "Этот код уже активирован.", already: true };
    state.codes.push(code); recomputeEnt(); save();
    var k = r.payload.k;
    return { ok: true, msg: k === "p" ? "⭐ Премиум активирован!" : k === "s" ? "✅ Предмет открыт!" : "✅ Подробный тест оплачен!" };
  }
  function importUrlCode() {
    try {
      var p = new URLSearchParams(location.search), c = p.get("c");
      if (!c) return;
      var r = addCode(c);
      toast(r.msg);
      history.replaceState(null, "", location.pathname);
    } catch (e) {}
  }

  /* ---------- Стрик ---------- */
  function streakN() { var m = L.RULES.STREAK_MODES[state.streakMode || "easy"] || L.RULES.STREAK_MODES.easy; return m.n; }
  // Режим (Лёгкий/Средний/Хард) задаёт, сколько предметов нужно выполнить для серии. Выбранные идут первыми, остальное добирается само.
  function requiredSubjects() {
    var n = streakN();
    var valid = function (s) { return s && access(s) === "open" && ready(s) && passedTopics(s.id).length > 0; };
    var list = state.streakSubjects.map(subj).filter(valid).slice(0, n);
    catalog.subjects.forEach(function (s) { if (list.length < n && valid(s) && list.indexOf(s) < 0) list.push(s); });
    return list;
  }
  function dailyDone(sid) { var d = state.daily[today()]; return !!(d && d[sid] && d[sid].done); }
  function checkStreakDay() {
    var req = requiredSubjects();
    if (req.length && req.every(function (s) { return dailyDone(s.id); })) {
      var before = state.streak.last;
      state.streak = L.completeDay(state.streak, today(), isPrem());
      return state.streak.last !== before;
    }
    return false;
  }

  /* ================= ЭКРАНЫ ================= */

  /* ---------- Главная ---------- */
  function renderHome() {
    var info = L.streakInfo(state.streak, today(), isPrem());
    var req = requiredSubjects();
    var sub = info.doneToday ? "Сегодня всё выполнено ✅"
      : info.status === "saveable" ? "❄️ Серия под защитой: выполни задания сегодня, и заморозка её сохранит"
      : info.status === "lost" ? "Серия сгорела 😢 Выполни задания и начни новую (рекорд: " + info.best + ")"
      : req.length ? "Выполни ежедневные задания" : "Пройди первую тему, чтобы открыть ежедневные задания";
    var h = '<div class="row sb"><div class="brand"><img src="logo.svg" alt=""><div><div class="name">Duck<b>school</b></div><div class="sub">Утка-школа · подготовка после 9 класса</div></div></div>' + (isPrem() ? '<span class="badge">⭐ премиум</span>' : "") + "</div>";
    h += '<div class="card"><div class="streak"><div class="num">🔥 ' + info.count + '</div><div class="grow"><b>' +
      plural(info.count, "день", "дня", "дней") + " подряд</b><div class=\"hint\">" + esc(sub) + "</div>" +
      '<div class="hint">❄️ Заморозок в этом месяце: ' + info.freezesLeft + " из " + info.freezesTotal + "</div></div></div>";
    if (req.length) {
      h += '<div style="margin-top:10px">' + req.map(function (s) {
        return '<button class="btn ' + (dailyDone(s.id) ? "ghost" : "") + ' small" style="margin:4px 6px 0 0" data-a="daily" data-arg="' + s.id + '">' +
          (dailyDone(s.id) ? "✅ " : "▶ ") + esc(s.title) + "</button>";
      }).join("") + "</div>";
    }
    h += "</div>";
    h += "<h2>Предметы</h2><div class=\"grid\">";
    catalog.subjects.forEach(function (s) {
      var a = access(s), rd = ready(s), passed = passedTopics(s.id).length, total = topicsOf(s.id).length;
      var line = !rd ? "скоро" : a === "open" ? (passed + " из " + total + " тем") : a === "choose" ? "бесплатно на выбор" : "🔒 " + CFG.PRICES.subject + " ⭐";
      h += '<button class="card ' + (a === "locked" || !rd ? "locked" : "") + '" data-a="subject" data-arg="' + s.id + '">' +
        '<span class="big">' + s.icon + " " + esc(s.title) + '</span><span class="sub">' + esc(line) + "</span>" +
        (rd && a === "open" && total ? '<div class="bar thin"><i style="width:' + Math.round(passed / total * 100) + '%"></i></div>' : "") + "</button>";
    });
    h += "</div>";
    h += '<h2>Узнай себя</h2><button class="card" data-a="career"><span class="big">🧭 Тест профориентации</span><span class="sub">Какие профессии тебе подходят</span></button>';
    h += '<div class="row" style="margin-top:14px"><button class="btn ghost" data-a="shop">⭐ Магазин</button><button class="btn ghost" data-a="settings">⚙️ Настройки</button></div>';
    setHtml(h);
  }

  /* ---------- Предмет ---------- */
  function renderSubject(sid) {
    var s = subj(sid);
    var a = access(s);
    if (!ready(s)) { setHtml(backBtn() + "<h1>" + s.icon + " " + esc(s.title) + '</h1><div class="note">Тем пока нет — скоро добавим.</div>'); return; }
    if (a === "choose") {
      confirmBox("Сделать «" + s.title + "» бесплатным предметом по выбору? Сменить его можно будет через " + L.RULES.ELECTIVE_CHANGE_DAYS + " дней, а остальные предметы открываются за " + CFG.PRICES.subject + " ⭐ или в премиуме.").then(function (yes) {
        if (yes) { state.elective = sid; state.electiveAt = nowMs(); save(); renderSubject(sid); } else back();
      });
      return;
    }
    if (a === "locked") {
      var swap = "";
      if (s.tier === "elective" && state.elective && state.elective !== sid) {
        var cur = subj(state.elective);
        if (L.canChangeElective(state, nowMs())) {
          swap = '<button class="btn ghost" style="margin-top:10px" data-a="swapElective" data-arg="' + sid + '">Сделать бесплатным вместо «' + esc(cur ? cur.title : "") + "»</button>";
        } else {
          swap = '<p class="hint" style="margin-top:10px">Бесплатный предмет «' + esc(cur ? cur.title : "") + "» можно сменить с " + fmtDate(L.electiveChangeAt(state)) + ". Чтобы не ждать, открой этот предмет за звёзды.</p>";
        }
      }
      setHtml(backBtn() + "<h1>" + s.icon + " " + esc(s.title) + '</h1><div class="note yellow"><p>Предмет закрыт.</p><p class="hint">Откроется навсегда за ' + CFG.PRICES.subject + ' ⭐ или входит в премиум.</p></div>' +
        '<button class="btn" style="margin-top:12px" data-a="buySubject" data-arg="' + sid + '">Открыть за ' + CFG.PRICES.subject + ' ⭐</button>' + swap +
        '<button class="btn ghost" style="margin-top:10px" data-a="shop">Премиум</button>');
      return;
    }
    var tops = topicsOf(sid), passed = passedTopics(sid).length;
    var h = backBtn() + "<h1>" + s.icon + " " + esc(s.title) + "</h1>";
    if (indexes[sid].demo) h += '<div class="note yellow hint">Демо-материалы. Настоящие темы появятся после генерации контента.</div>';
    h += '<div class="row" style="margin:10px 0"><button class="btn" data-a="daily" data-arg="' + sid + '">' + (dailyDone(sid) ? "✅ Задания дня выполнены" : "📅 Задания на сегодня") + "</button></div>";
    var weekOk = L.canTakeExam(state, sid, isPrem(), nowMs());
    h += '<div class="grid"><button class="card" data-a="examMenu" data-arg="' + sid + '"><span class="big">📝 Экзамен</span><span class="sub">' + (isPrem() ? "без ограничений" : weekOk ? "бесплатная попытка доступна" : "следующая бесплатная — " + fmtDate(L.nextExamAt(state, sid))) + "</span></button>" +
      '<button class="card ' + (isPrem() ? "" : "locked") + '" data-a="mistakes" data-arg="' + sid + '"><span class="big">🔁 Ошибки</span><span class="sub">' + (isPrem() ? "работа над ошибками" : "🔒 премиум · после бесплатного экзамена разбор есть") + "</span></button></div>";
    h += "<h2>Темы · пройдено " + passed + " из " + tops.length + "</h2><div class=\"stack\">";
    tops.forEach(function (t) {
      var st = state.topics[t.id];
      h += '<button class="card" data-a="lesson" data-arg="' + t.id + '"><span class="big">' + (st && st.passed ? "✅ " : "📘 ") + esc(t.title) + '</span><span class="sub">' +
        (st && st.passed ? "лучший результат " + st.best + " из 6" : st && st.attempts ? "последняя попытка " + st.last + " из 6" : "конспект, пример и 6 заданий") + "</span></button>";
    });
    h += "</div>";
    setHtml(h);
  }

  /* ---------- Урок ---------- */
  function renderLesson(tid) {
    var sid = subjectOfTopic(tid);
    loadTopic(sid, tid).then(function (t) {
      var l = t.lesson || {};
      var h = backBtn() + "<h1>" + esc(t.title) + '</h1><div class="lesson lesson-wrap">';
      if (l.intro) h += '<div class="duck-say"><img src="logo.svg" alt=""><div class="bubble">' + L.renderRich(l.intro) + "</div></div>";
      (l.sections || []).forEach(function (sec) { h += "<h2>" + esc(sec.title) + "</h2>" + L.renderRich(sec.body); });
      if (l.notebook && l.notebook.length) h += '<div class="notebook"><h3>📝 Выпиши в тетрадь</h3><ul>' + l.notebook.map(function (x) { return "<li>" + L.renderRich(x).replace(/^<p>|<\/p>$/g, "") + "</li>"; }).join("") + "</ul></div>";
      if (l.example) h += "<h2>Разберём пример</h2><div class=\"example\"><b>Задача.</b> " + L.renderRich(l.example.task).replace(/^<p>|<\/p>$/g, "") + "</div><details><summary>Показать решение</summary>" + L.renderRich(l.example.solution) + "</details>";
      h += '</div><button class="btn yellow" style="margin-top:14px" data-a="practice" data-arg="' + tid + '">К заданиям (3 вопроса + 3 задачи)</button>';
      setHtml(h);
    }).catch(function () { setHtml(backBtn() + '<div class="note">Не удалось загрузить тему. Проверьте интернет.</div>'); });
  }
  function subjectOfTopic(tid) {
    for (var sid in indexes) {
      var ix = indexes[sid];
      if (ix && ix.topics && ix.topics.some(function (t) { return t.id === tid; })) return sid;
    }
    return "";
  }

  /* ---------- Раннер заданий ---------- */
  function startRun(cfg) {
    var items = cfg.items.map(function (e) {
      var perm = null;
      if (e.kind === "q") { perm = []; for (var i = 0; i < e.data.options.length; i++) perm.push(i); perm = L.shuffled(perm, Math.random); }
      return { e: e, perm: perm };
    });
    run = { cfg: cfg, items: items, answers: items.map(function () { return null; }), idx: 0, finished: false };
    stopTimer();
    if (cfg.minutes) {
      run.endsAt = Date.now() + cfg.minutes * 60000;
      timerId = setInterval(tick, 1000);
    }
    renderRun();
  }
  function tick() {
    if (!run || !run.endsAt) return stopTimer();
    var left = Math.max(0, Math.round((run.endsAt - Date.now()) / 1000));
    var el = document.getElementById("timer");
    if (el) el.textContent = Math.floor(left / 60) + ":" + ("0" + (left % 60)).slice(-2);
    if (left <= 0) { toast("Время вышло"); finishRun(true); }
  }
  function renderRun() {
    var r = run, it = r.items[r.idx], e = it.e, n = r.items.length;
    var h = '<div class="row sb"><button class="back" data-a="quit">✕ Выйти</button>' + (r.endsAt ? '<span class="timer" id="timer">…</span>' : "") + "</div>";
    h += '<div class="hint">' + esc(r.cfg.title) + " · " + (r.idx + 1) + " из " + n + '</div><div class="bar"><i style="width:' + Math.round(r.idx / n * 100) + '%"></i></div>';
    h += '<div class="q-text">' + L.renderRich(e.data.text) + "</div>";
    if (e.kind === "q") {
      it.perm.forEach(function (orig) {
        h += '<button class="opt ' + (r.answers[r.idx] === orig ? "on" : "") + '" data-a="pick" data-arg="' + orig + '">' + esc(e.data.options[orig]) + "</button>";
      });
    } else {
      var hint = e.data.hint || (e.data.type === "set" ? "Если ответов несколько — запиши через «;»" : e.data.type === "text" ? "Запиши ответ словом или выражением" : "Запиши ответ числом");
      h += '<input class="ans" id="ans" autocomplete="off" autocapitalize="off" spellcheck="false" value="' + esc(r.answers[r.idx] || "") + '" placeholder="Твой ответ"><div class="hint" style="margin-top:6px">' + esc(hint) + "</div>";
    }
    h += '<div class="row" style="margin-top:16px">' + (r.idx > 0 ? '<button class="btn ghost" data-a="prev">←</button>' : "") +
      '<button class="btn" data-a="next">' + (r.idx === n - 1 ? "Завершить" : "Далее") + "</button></div>";
    setHtml(h);
    var inp = document.getElementById("ans");
    if (inp) {
      inp.addEventListener("input", function () { run.answers[run.idx] = inp.value; });
      inp.addEventListener("keydown", function (ev) { if (ev.key === "Enter") { ev.preventDefault(); runNext(); } });
    }
    if (r.endsAt) tick();
  }
  function runNext() {
    if (!run) return;
    if (run.idx < run.items.length - 1) { run.idx++; renderRun(); } else finishRun(false);
  }
  function finishRun(force) {
    if (!run || run.finished) return;
    var unanswered = run.answers.filter(function (a) { return a == null || String(a).trim() === ""; }).length;
    var go2 = function () { run.finished = true; stopTimer(); doFinish(); };
    if (!force && unanswered) {
      confirmBox("Без ответа: " + unanswered + ". Завершить всё равно?").then(function (y) { if (y) go2(); });
    } else go2();
  }
  function grade() {
    var res = run.items.map(function (it, i) {
      var e = it.e, a = run.answers[i], ok, your, right;
      if (e.kind === "q") {
        ok = a === e.data.correct;
        your = a == null ? "— нет ответа —" : e.data.options[a];
        right = e.data.options[e.data.correct];
      } else {
        ok = L.checkTask(e.data, a);
        your = a == null || String(a).trim() === "" ? "— нет ответа —" : String(a);
        right = L.formatAnswer(e.data);
      }
      return { e: e, ok: ok, your: your, right: right };
    });
    return { list: res, right: res.filter(function (x) { return x.ok; }).length, total: res.length };
  }
  function updateErrors(result, ok2Dec) {
    result.list.forEach(function (x) {
      var k = x.e.key, c = state.errors[k] || 0;
      if (x.ok) { c = Math.max(0, c - (ok2Dec || 1)); if (c) state.errors[k] = c; else delete state.errors[k]; }
      else state.errors[k] = c + 1;
    });
  }
  function doFinish() {
    var result = grade(), cfg = run.cfg, extra = {};
    if (cfg.kind === "practice") {
      var st = state.topics[cfg.topicId] || { passed: false, best: 0, attempts: 0, last: 0, passedAt: 0 };
      st.attempts++; st.last = result.right; st.best = Math.max(st.best || 0, result.right);
      if (result.right >= L.RULES.PASS_MIN && !st.passed) { st.passed = true; st.passedAt = Date.now(); extra.newlyPassed = true; }
      extra.passed = result.right >= L.RULES.PASS_MIN;
      state.topics[cfg.topicId] = st;
      updateErrors(result);
    } else if (cfg.kind === "daily") {
      state.daily[today()] = state.daily[today()] || {};
      state.daily[today()][cfg.subjectId] = { done: true, score: result.right };
      updateErrors(result);
      extra.streakAdvanced = checkStreakDay();
    } else if (cfg.kind === "exam") {
      updateErrors(result);
    } else if (cfg.kind === "mistakes") {
      updateErrors(result, 2);
    }
    L.pruneState(state, today()); save();
    haptic(result.right >= result.total * 0.6 ? "success" : "warning");
    renderResult(result, cfg, extra);
  }

  function renderResult(result, cfg, extra) {
    var pct = Math.round(result.right / Math.max(1, result.total) * 100);
    var h = '<div class="center"><div class="big-emoji">' + (pct >= 90 ? "🏆" : pct >= 60 ? "🎉" : "💪") + "</div><h1>" + result.right + " из " + result.total + "</h1>";
    if (cfg.kind === "practice") h += "<p>" + (extra.passed ? (extra.newlyPassed ? "Тема пройдена! ✅" : "Отлично, тема уже пройдена ✅") : "Для зачёта нужно " + L.RULES.PASS_MIN + " из 6. Разбери ошибки и попробуй ещё раз.") + "</p>";
    if (cfg.kind === "daily") h += "<p>" + (extra.streakAdvanced ? (state.streak.lf === today() ? "❄️ Заморозка спасла серию! " : "") + "🔥 Серия продолжается: " + state.streak.count + " " + plural(state.streak.count, "день", "дня", "дней") : "Задания дня выполнены ✅") + "</p>";
    h += "</div>";
    var wrong = result.list.filter(function (x) { return !x.ok; });
    if (wrong.length) {
      h += "<h2>Работа над ошибками (" + wrong.length + ")</h2>";
      wrong.forEach(function (x) {
        var d = x.e.data;
        h += '<div class="review"><div>' + L.renderRich(d.text) + '</div><div class="your">Твой ответ: ' + esc(x.your) + '</div><div class="right">Правильно: ' + esc(x.right) + "</div>" +
          ((d.explain || d.solution) ? '<div class="hint" style="margin-top:6px">' + L.renderRich(d.explain || d.solution) + "</div>" : "") + "</div>";
      });
    } else h += '<div class="note green">Ошибок нет — так держать!</div>';
    h += '<div class="stack" style="margin-top:14px">';
    if (cfg.kind === "practice") {
      h += '<button class="btn" data-a="practice" data-arg="' + cfg.topicId + '">' + (extra.passed ? "Ещё раз" : "Попробовать снова") + "</button>";
      h += '<button class="btn ghost" data-a="lesson" data-arg="' + cfg.topicId + '">Перечитать конспект</button>';
    }
    h += '<button class="btn ghost" data-a="finishRun">' + (cfg.subjectId ? "К предмету" : "На главную") + "</button></div>";
    setHtml(h);
    run = null;
  }

  /* ---------- Практика темы ---------- */
  function startPractice(tid) {
    var sid = subjectOfTopic(tid);
    loadTopic(sid, tid).then(function (t) {
      var items = L.practiceItems(t);
      if (!items.length) { toast("В теме нет заданий"); return; }
      startRun({ kind: "practice", title: t.title, topicId: tid, subjectId: sid, items: items });
    }).catch(function () { toast("Не удалось загрузить тему"); });
  }

  /* ---------- Ежедневные задания ---------- */
  function renderDaily(sid) {
    var s = subj(sid);
    if (access(s) !== "open") return go(renderSubject, sid);
    var d = state.daily[today()] && state.daily[today()][sid];
    var h = backBtn() + "<h1>📅 " + esc(s.title) + ": задания дня</h1>";
    if (d && d.done) {
      h += '<div class="note green"><b>Сегодня выполнено ✅</b><p>Результат: ' + d.score + ' из 10. Новые задания появятся завтра.</p></div>';
      setHtml(h); return;
    }
    var passed = passedTopics(sid);
    if (!passed.length) {
      var first = topicsOf(sid).filter(function (t) { return !(state.topics[t.id] && state.topics[t.id].passed); })[0];
      h += '<div class="note yellow"><p><b>Сначала пройди хотя бы одну тему.</b></p><p class="hint">Ежедневные задания собираются из тем, которые ты уже выучил.</p></div>';
      if (first) h += '<button class="btn" style="margin-top:12px" data-a="lesson" data-arg="' + first.id + '">Начать с «' + esc(first.title) + "»</button>";
      setHtml(h); return;
    }
    var review = L.isReviewDay(new Date());
    h += '<div class="note">' + (review ? "<b>🔄 День повторения.</b> Сегодня только старые темы." : "<b>5 вопросов и 5 задач.</b> Больше про последнюю тему, плюс повторение старых.") + "</div>";
    h += '<button class="btn" style="margin-top:12px" data-a="startDaily" data-arg="' + sid + '">Начать</button>';
    setHtml(h);
  }
  function startDaily(sid) {
    learnedPools(sid).then(function (learned) {
      var pick = L.pickDaily({ learned: learned, errors: state.errors, seed: today() + "|" + uid + "|" + sid, review: L.isReviewDay(new Date()) });
      if (pick.needLearn || !pick.items.length) { toast("Нет заданий: пройди тему"); return; }
      startRun({ kind: "daily", title: "Задания дня", subjectId: sid, items: pick.items });
    });
  }

  /* ---------- Экзамен ---------- */
  function renderExamMenu(sid) {
    var s = subj(sid), can = L.canTakeExam(state, sid, isPrem(), nowMs());
    var h = backBtn() + "<h1>📝 Экзамен: " + esc(s.title) + "</h1>";
    h += '<div class="note">' + L.RULES.EXAM_Q + " вопросов + " + L.RULES.EXAM_T + " задач, " + L.RULES.EXAM_MINUTES + " минут. После экзамена — разбор ошибок.<br><span class=\"hint\">" +
      (isPrem() ? "Премиум: без ограничений." : can ? "Бесплатно: 1 экзамен на предмет, следующий через " + L.RULES.EXAM_COOLDOWN_DAYS + " дней после прошлого. Попытка доступна." : "Бесплатная попытка уже использована — следующая " + fmtDate(L.nextExamAt(state, sid)) + " или в премиуме.") + "</span></div>";
    if (!can) h += '<button class="btn ghost" style="margin-top:10px" data-a="shop">Снять ограничение (премиум)</button>';
    h += "<h2>Выбери тему</h2><div class=\"stack\">";
    var passed = passedTopics(sid);
    if (passed.length) h += '<button class="card" ' + (can ? "" : "disabled") + ' data-a="examSubject" data-arg="' + sid + '"><span class="big">🎯 По всему предмету</span><span class="sub">вперемешку из пройденных тем (' + passed.length + ")</span></button>";
    topicsOf(sid).forEach(function (t) {
      var st = state.topics[t.id];
      h += '<button class="card ' + (can ? "" : "locked") + '" data-a="examTopic" data-arg="' + t.id + '"><span class="big">' + (st && st.passed ? "✅ " : "📘 ") + esc(t.title) + "</span></button>";
    });
    h += "</div>";
    setHtml(h);
  }
  function beginExam(sid, items, label, onStart) {
    if (!L.canTakeExam(state, sid, isPrem(), nowMs())) { toast("Следующая бесплатная попытка: " + fmtDate(L.nextExamAt(state, sid))); return; }
    var go2 = function () {
      state.exams[sid] = nowMs(); if (onStart) onStart(); save();
      startRun({ kind: "exam", title: "Экзамен: " + label, subjectId: sid, items: items, minutes: L.RULES.EXAM_MINUTES });
    };
    if (isPrem()) go2();
    else confirmBox("Это ваша бесплатная попытка по этому предмету; следующая будет через 7 дней. Начать?").then(function (y) { if (y) go2(); });
  }
  function startExamTopic(tid) {
    var sid = subjectOfTopic(tid);
    loadTopic(sid, tid).then(function (t) {
      var attempt = state.examAttempts[tid] || 0;
      var items = L.examItems(t, attempt);
      if (!items.length) { toast("В теме нет экзаменационных заданий"); return; }
      beginExam(sid, items, t.title, function () { state.examAttempts[tid] = attempt + 1; });
    }).catch(function () { toast("Не удалось загрузить тему"); });
  }
  function startExamSubject(sid) {
    learnedPools(sid).then(function (learned) {
      var items = L.subjectExamItems(learned.map(function (x) { return x.topic; }), "ex|" + uid + "|" + Date.now());
      if (!items.length) { toast("Сначала пройди хотя бы одну тему"); return; }
      beginExam(sid, items, "весь предмет");
    });
  }

  /* ---------- Работа над ошибками (премиум) ---------- */
  function startMistakes(sid) {
    if (!isPrem()) {
      setHtml(backBtn() + "<h1>🔁 Работа над ошибками</h1>" + '<div class="note yellow"><p>Свободная тренировка своих ошибок — в премиуме.</p><p class="hint">Без премиума разбор ошибок показывается после каждого экзамена (раз в неделю).</p></div><button class="btn" style="margin-top:12px" data-a="shop">Премиум</button>');
      return;
    }
    var tids = {};
    Object.keys(state.errors).forEach(function (k) { var tid = k.split(":")[0]; if (topicsOf(sid).some(function (t) { return t.id === tid; })) tids[tid] = true; });
    var list = Object.keys(tids);
    if (!list.length) { toast("Ошибок пока нет 🎉"); return; }
    Promise.all(list.map(function (tid) { return loadTopic(sid, tid).catch(function () { return null; }); })).then(function (ts) {
      var entries = [];
      ts.forEach(function (t) { if (t) { var f = L.flattenTopic(t); entries = entries.concat(f.questions, f.tasks); } });
      entries = entries.filter(function (e) { return state.errors[e.key]; })
        .sort(function (a, b) { return state.errors[b.key] - state.errors[a.key]; }).slice(0, 10);
      if (!entries.length) { toast("Ошибок пока нет 🎉"); return; }
      startRun({ kind: "mistakes", title: "Работа над ошибками", subjectId: sid, items: L.shuffled(entries, Math.random) });
    });
  }

  /* ---------- Профориентация ---------- */
  function loadCareer() {
    if (careerData) return Promise.resolve(careerData);
    return Promise.all([fetchJSON("data/career30.json"), fetchJSON("data/career60.json"), fetchJSON("data/career_types.json")]).then(function (r) {
      careerData = { free: r[0], paid: r[1], types: r[2] }; return careerData;
    });
  }
  function unusedCareerNonce() {
    var used = state.career.usedNonces || [];
    return ent.career.filter(function (n) { return used.indexOf(n) < 0; })[0] || null;
  }
  function answeredCount(a) { return (a || []).filter(function (x) { return x >= 1; }).length; }
  function renderCareer() {
    loadCareer().then(function (cd) {
      var f = state.career.free, p = state.career.paid;
      var fN = answeredCount(f.a), pN = answeredCount(p.a), nonce = unusedCareerNonce();
      var h = backBtn() + "<h1>🧭 Тест профориентации</h1><p class=\"hint\">Это ориентир для размышления, а не приговор. Интересы меняются.</p>";
      h += '<button class="card" data-a="careerStart" data-arg="free"><span class="big">⚡ Быстрый тест · 30 вопросов</span><span class="sub">бесплатно · ' +
        (fN >= 30 ? "пройден — посмотреть результат" : fN ? "продолжить: " + fN + " из 30" : "5–7 минут") + "</span></button>";
      var paidDone = pN >= 60 && !p.nonce;
      var label = p.nonce && pN < 60 ? "продолжить: " + pN + " из 60" : paidDone ? "пройден — посмотреть результат" : nonce ? "оплачен — можно начинать" : CFG.PRICES.career + " ⭐ · 60 вопросов + подробный разбор от ИИ";
      h += '<button class="card" style="margin-top:10px" data-a="careerStart" data-arg="paid"><span class="big">🔎 Подробный тест · 60 вопросов</span><span class="sub">' + esc(label) + "</span></button>";
      h += '<p class="hint" style="margin-top:10px">Тест можно свернуть и продолжить позже — ответы сохраняются.</p>';
      if (paidDone) h += '<button class="btn ghost" style="margin-top:6px" data-a="careerStart" data-arg="paidNew">Пройти подробный тест заново (' + CFG.PRICES.career + " ⭐)</button>";
      setHtml(h);
    }).catch(function () { setHtml(backBtn() + '<div class="note">Не удалось загрузить тест.</div>'); });
  }
  var careerRun = null;
  function careerStart(which) {
    loadCareer().then(function (cd) {
      var isPaid = which !== "free", slot = isPaid ? state.career.paid : state.career.free;
      var test = isPaid ? cd.paid : cd.free, n = test.items.length;
      if (isPaid) {
        var finished = answeredCount(slot.a) >= n && !slot.nonce;
        if (which === "paidNew" || (!slot.nonce && !finished)) {
          var nonce = unusedCareerNonce();
          if (!nonce) { openBuyCareer(); return; }
          slot.a = []; slot.nonce = nonce; save();
        } else if (finished) { return renderCareerResult("paid"); }
      } else if (answeredCount(slot.a) >= n) { return renderCareerResult("free"); }
      var first = 0; while (first < n && slot.a[first] >= 1) first++;
      careerRun = { which: isPaid ? "paid" : "free", idx: Math.min(first, n - 1) };
      renderCareerQ();
    });
  }
  function openBuyCareer() {
    setHtml('<button class="back" data-a="reshow">← К тестам</button>' + "<h1>🔎 Подробный тест</h1>" + '<div class="note"><p>60 вопросов и персональный разбор от ИИ: сильные стороны, подходящие профессии, что делать в ближайший год.</p><p class="hint">Стоимость ' + CFG.PRICES.career + ' ⭐. Оплата в чате с ботом, потом вернись сюда — тест откроется сам.</p></div>' +
      '<button class="btn" style="margin-top:12px" data-a="buyCareer">Оплатить ' + CFG.PRICES.career + " ⭐</button>");
  }
  function renderCareerQ() {
    var cd = careerData, cr = careerRun, test = cr.which === "paid" ? cd.paid : cd.free, slot = state.career[cr.which], n = test.items.length;
    var it = test.items[cr.idx], cur = slot.a[cr.idx] || 0;
    var h = '<div class="row sb"><button class="back" data-a="careerExit">← Свернуть</button><span class="hint">можно продолжить позже</span></div>';
    h += '<div class="hint">' + (cr.idx + 1) + " из " + n + '</div><div class="bar"><i style="width:' + Math.round(answeredCount(slot.a) / n * 100) + '%"></i></div>';
    h += '<div class="q-text" style="min-height:90px">' + esc(it.q) + "</div>";
    h += '<div class="scale">' + [1, 2, 3, 4, 5].map(function (v) { return '<button class="' + (cur === v ? "on" : "") + '" data-a="careerAns" data-arg="' + v + '">' + v + "</button>"; }).join("") + "</div>";
    h += '<div class="scale-labels"><span>' + esc(test.scale[0]) + "</span><span>" + esc(test.scale[4]) + "</span></div>";
    h += '<div class="row" style="margin-top:18px">' + (cr.idx > 0 ? '<button class="btn ghost" data-a="careerPrev">←</button>' : "") + "</div>";
    setHtml(h);
  }
  function careerAnswer(v) {
    var cr = careerRun, test = cr.which === "paid" ? careerData.paid : careerData.free, slot = state.career[cr.which];
    slot.a[cr.idx] = +v; save();
    if (cr.idx < test.items.length - 1) { cr.idx++; renderCareerQ(); }
    else if (answeredCount(slot.a) >= test.items.length) {
      if (cr.which === "paid" && slot.nonce) { state.career.usedNonces.push(slot.nonce); slot.nonce = null; save(); }
      careerRun = null; renderCareerResult(cr.which);
    } else { var i = 0; while (slot.a[i] >= 1) i++; cr.idx = i; renderCareerQ(); }
  }
  function renderCareerResult(which) {
    var cd = careerData, test = which === "paid" ? cd.paid : cd.free, slot = state.career[which];
    var r = L.scoreCareer(test.items, slot.a);
    var h = '<button class="back" data-a="reshow">← К тестам</button><h1>🧭 Твой результат</h1>';
    r.order.forEach(function (t) {
      h += '<div class="tbar"><span class="name">' + cd.types[t].emoji + " " + esc(cd.types[t].name) + '</span><span class="track"><i style="width:' + r.pct[t] + '%"></i></span><span class="pct">' + r.pct[t] + "%</span></div>";
    });
    r.top.slice(0, 2).forEach(function (t) {
      var ty = cd.types[t];
      h += "<h2>" + ty.emoji + " " + esc(ty.name) + '</h2><div class="note"><p>' + esc(ty.summary) + "</p><b>Сильные стороны</b><ul>" + ty.strengths.map(function (x) { return "<li>" + esc(x) + "</li>"; }).join("") +
        "</ul><b>Возможные профессии</b><ul>" + ty.professions.map(function (x) { return "<li>" + esc(x) + "</li>"; }).join("") + "</ul>" +
        '<div class="hint">Подходящие предметы: ' + ty.subjects.map(function (id) { var s = subj(id); return s ? esc(s.title) : ""; }).filter(Boolean).join(", ") + "</div></div>";
    });
    if (which === "paid") {
      h += '<button class="btn" style="margin-top:14px" data-a="careerAnalysis">🤖 Получить подробный разбор</button><p class="hint">Разбор придёт сообщением в чат с ботом. Передаются только ваши оценки, без имени.</p>';
    } else {
      h += '<div class="note yellow" style="margin-top:14px"><b>Хочешь глубже?</b><p class="hint">Подробный тест на 60 вопросов и персональный разбор — ' + CFG.PRICES.career + ' ⭐.</p></div><button class="btn ghost" style="margin-top:8px" data-a="careerStart" data-arg="paid">Подробный тест</button>' +
        '<button class="btn ghost" style="margin-top:8px" data-a="careerReset">Пройти быстрый тест заново</button>';
    }
    setHtml(h);
  }

  /* ---------- Магазин ---------- */
  function renderShop() {
    var P = CFG.PRICES, h = backBtn() + "<h1>⭐ Магазин</h1>";
    var until = ent.premiumUntil;
    h += '<div class="card"><span class="big">Премиум на ' + (CFG.PREMIUM_DAYS || 30) + " дней</span>";
    h += '<span class="sub">' + (isPrem() ? "активен до " + new Date(until * 1000).toLocaleDateString("ru-RU") : "не активен") + "</span>";
    h += "<ul style=\"margin-top:8px\"><li>Все предметы открыты</li><li>Экзамены без ограничений</li><li>Работа над ошибками когда угодно</li><li>3 заморозки стрика в месяц (вместо 1), пропуск до 14 дней</li></ul>";
    h += '<button class="btn" data-a="buyPremium">' + (isPrem() ? "Продлить" : "Получить") + " · " + P.premium + " ⭐</button>";
    h += '<p class="hint" style="margin:8px 0 0">Цена запуска (первая неделя), потом ' + P.premiumRegular + " ⭐ за месяц.</p></div>";
    var paid = catalog.subjects.filter(function (s) { return s.tier !== "free" && access(s) !== "open"; });
    if (paid.length) {
      h += "<h2>Открыть предмет навсегда · " + P.subject + " ⭐</h2><div class=\"grid\">";
      paid.forEach(function (s) { h += '<button class="card" data-a="buySubject" data-arg="' + s.id + '"><span class="big">' + s.icon + " " + esc(s.title) + '</span><span class="sub">' + P.subject + " ⭐</span></button>"; });
      h += "</div>";
    }
    h += '<h2>У меня есть код</h2><textarea class="code" id="codeIn" placeholder="Вставьте код из чата с ботом"></textarea><button class="btn ghost" style="margin-top:8px" data-a="applyCode">Активировать</button>';
    h += '<p class="hint" style="margin-top:14px">После оплаты код приходит в чат с ботом и обычно активируется автоматически. Если нет — нажми /code в боте.</p>';
    setHtml(h);
  }

  /* ---------- Настройки ---------- */
  function renderSettings() {
    var ok = catalog.subjects.filter(function (s) { return access(s) === "open" && ready(s); });
    var modes = L.RULES.STREAK_MODES, cur = state.streakMode || "easy", n = modes[cur].n;
    var h = backBtn() + "<h1>⚙️ Настройки</h1><h2>Сложность стрика</h2><p class=\"hint\">От режима зависит, по скольким предметам нужно выполнить задания дня, чтобы серия продолжилась.</p><div class=\"row\">";
    Object.keys(modes).forEach(function (k) {
      h += '<button class="btn ' + (k === cur ? "" : "ghost") + ' small" data-a="setMode" data-arg="' + k + '">' + modes[k].title + " · " + modes[k].n + "</button>";
    });
    h += "</div><h2>Предметы для стрика</h2><p class=\"hint\">Выбери до " + n + ". Если выберешь меньше, остальные добавятся сами из доступных предметов с пройденными темами.</p>";
    ok.forEach(function (s) {
      h += '<label class="chk"><input type="checkbox" data-a="toggleStreak" data-arg="' + s.id + '" ' + (state.streakSubjects.indexOf(s.id) >= 0 ? "checked" : "") + "> " + s.icon + " " + esc(s.title) + "</label>";
    });
    if (!ok.length) h += '<div class="note">Пока нет доступных предметов с темами.</div>';
    h += '<h2>Данные</h2><button class="btn ghost" data-a="resetAll">Сбросить мой прогресс</button><p class="hint">Покупки (коды) сохранятся.</p>';
    h += '<p class="hint" style="margin-top:18px">Твой ID для поддержки: ' + uid + "</p>";
    setHtml(h);
  }

  /* ================= Обработчик кликов ================= */
  var actions = {
    back: back,
    reshow: reshow,
    quit: function () { confirmBox("Выйти? Прогресс этого набора не сохранится.").then(function (y) { if (y) { stopTimer(); run = null; reshow(); } }); },
    subject: function (id) { go(renderSubject, id); },
    lesson: function (id) { var cur = nav[nav.length - 1]; if (cur && cur.fn === renderLesson) nav.pop(); go(renderLesson, id); },
    practice: function (id) { startPractice(id); },
    pick: function (v) { run.answers[run.idx] = +v; renderRun(); },
    next: runNext,
    prev: function () { if (run && run.idx > 0) { run.idx--; renderRun(); } },
    finishRun: function () {
      run = null; stopTimer();
      while (nav.length && [renderLesson, renderDaily, renderExamMenu].indexOf(nav[nav.length - 1].fn) >= 0) nav.pop();
      reshow(); syncBack();
    },
    daily: function (id) { go(renderDaily, id); },
    startDaily: startDaily,
    examMenu: function (id) { go(renderExamMenu, id); },
    examTopic: startExamTopic,
    examSubject: startExamSubject,
    mistakes: function (id) { if (isPrem()) startMistakes(id); else go(function () { startMistakes(id); }); },
    career: function () { go(renderCareer); },
    careerStart: careerStart,
    careerAns: careerAnswer,
    careerPrev: function () { if (careerRun && careerRun.idx > 0) { careerRun.idx--; renderCareerQ(); } },
    careerExit: function () { careerRun = null; save(); store && store.flush(); reshow(); },
    careerReset: function () { confirmBox("Стереть ответы быстрого теста и пройти заново?").then(function (y) { if (y) { state.career.free.a = []; save(); careerStart("free"); } }); },
    careerAnalysis: function () { openBot("a" + L.encodeAnswers(state.career.paid.a, 60)); },
    buyCareer: function () { openBot("buy_career"); },
    buyPremium: function () { openBot("premium"); },
    buySubject: function (id) { openBot("subj_" + id); },
    shop: function () { go(renderShop); },
    settings: function () { go(renderSettings); },
    applyCode: function () {
      var r = addCode(document.getElementById("codeIn").value);
      toast(r.msg); if (r.ok && !r.already) renderShop();
    },
    toggleStreak: function (id, el) {
      var list = state.streakSubjects.filter(function (x) { return x !== id; });
      if (el.checked) list.push(id);
      var n = streakN();
      if (list.length < 1 || list.length > n) { toast("Выбери от 1 до " + n + " предметов (по режиму стрика)"); el.checked = !el.checked; return; }
      state.streakSubjects = list; save();
    },
    setMode: function (k) {
      if (!L.RULES.STREAK_MODES[k]) return;
      state.streakMode = k;
      state.streakSubjects = state.streakSubjects.slice(0, L.RULES.STREAK_MODES[k].n);
      save(); renderSettings();
    },
    swapElective: function (id) {
      var s = subj(id), cur = subj(state.elective);
      confirmBox("Сделать «" + s.title + "» бесплатным вместо «" + (cur ? cur.title : "") + "»? Следующая смена будет возможна через " + L.RULES.ELECTIVE_CHANGE_DAYS + " дней. «" + (cur ? cur.title : "") + "» закроется, прогресс сохранится.").then(function (yes) {
        if (!yes) return;
        state.elective = id; state.electiveAt = nowMs(); save(); renderSubject(id);
      });
    },
    resetAll: function () {
      confirmBox("Точно сбросить весь прогресс (темы, стрик, ошибки, тесты)? Покупки останутся.").then(function (y) {
        if (!y) return;
        var codes = state.codes, fresh = L.defaultState(); fresh.codes = codes; state = fresh; save(); store && store.flush(); toast("Прогресс сброшен"); goHome();
      });
    }
  };
  function onClick(ev) {
    var t = ev.target.closest && ev.target.closest("[data-a]");
    if (!t || t.disabled || t.type === "checkbox") return;
    var fn = actions[t.dataset.a];
    if (fn) { ev.preventDefault(); fn(t.dataset.arg, t); }
  }
  function onChange(ev) {
    var t = ev.target;
    if (t && t.type === "checkbox" && t.dataset.a) actions[t.dataset.a](t.dataset.arg, t);
  }

  /* ================= Запуск ================= */
  function mergeState(saved) {
    var d = L.defaultState();
    if (!saved) return d;
    var o = Object.assign(d, saved);
    o.streak = Object.assign(d.streak, saved.streak || {});
    o.career = Object.assign({ free: { a: [] }, paid: { a: [], nonce: null }, usedNonces: [] }, saved.career || {});
    o.career.free = Object.assign({ a: [] }, o.career.free); o.career.paid = Object.assign({ a: [], nonce: null }, o.career.paid);
    o.career.usedNonces = o.career.usedNonces || [];
    return o;
  }
  function boot() {
    document.addEventListener("click", onClick);
    document.addEventListener("change", onChange);
    applyTheme();
    if (tg) {
      try { tg.onEvent("themeChanged", applyTheme); } catch (e) {}
      try { tg.ready(); tg.expand(); tg.BackButton.onClick(function () { if (run) actions.quit(); else back(); }); } catch (e) {}
      try { uid = (tg.initDataUnsafe && tg.initDataUnsafe.user && tg.initDataUnsafe.user.id) || 0; authDate = Number(tg.initDataUnsafe && tg.initDataUnsafe.auth_date) || 0; } catch (e) { uid = 0; }
    }
    store = S.createStore({ adapters: [S.cloudAdapter(tg), S.localAdapter(window.localStorage)] });
    document.addEventListener("visibilitychange", function () { if (document.hidden && store) store.flush(); });
    window.addEventListener("pagehide", function () { if (store) store.flush(); });
    fetchJSON("data/catalog.json").then(function (c) { catalog = c; return store.load(); }).then(function (saved) {
      state = mergeState(saved);
      importUrlCode(); recomputeEnt();
      state.streak = L.settleStreak(state.streak, today(), isPrem());
      return Promise.all(catalog.subjects.map(function (s) {
        return fetchJSON(s.topics).then(function (ix) { indexes[s.id] = ix; }).catch(function () { indexes[s.id] = null; });
      }));
    }).then(function () { save(); goHome(); }).catch(function () {
      setHtml('<div class="note"><b>Не удалось загрузить приложение.</b><p class="hint">Проверьте интернет и откройте его заново.</p></div>');
    });
  }
  window.__app = { get state() { return state; }, L: L };   // для отладки в консоли
  boot();
})();
