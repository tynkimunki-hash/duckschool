// Запуск: node --test app/tests/
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const L = require("../js/logic.js");
const nacl = require("../vendor/nacl-fast.min.js");

/* ---------- Проверка ответов ---------- */
test("checkTask: число", () => {
  const t = { type: "number", answer: "6" };
  for (const ok of ["6", "6.0", " x = 6 ", "12/2", "6,0", "+6", "x=6."]) assert.equal(L.checkTask(t, ok), true, ok);
  for (const bad of ["7", "", "  ", "шесть", "-6", "6.1"]) assert.equal(L.checkTask(t, bad), false, bad);
  assert.equal(L.checkTask({ type: "number", answer: "2.5" }, "2,5"), true);
  assert.equal(L.checkTask({ type: "number", answer: "-0.5" }, "−1/2"), true);   // юникод-минус
  assert.equal(L.checkTask({ type: "number", answer: "5", accept: ["пять"] }, "Пять"), true);
});
test("checkTask: несколько корней", () => {
  const t = { type: "set", answer: ["2", "-3"] };
  for (const ok of ["2; -3", "-3, 2", "2 и -3", "2 -3", "2,-3", "x=2; x=-3", "2;-3;2"]) assert.equal(L.checkTask(t, ok), true, ok);
  for (const bad of ["2", "2; 3", "-3", "2; -3; 5", "abc"]) assert.equal(L.checkTask(t, bad), false, bad);
  assert.equal(L.checkTask({ type: "set", answer: ["0.5", "1"] }, "0,5; 1"), true);   // десятичная запятая
});
test("checkTask: текст и выражения", () => {
  const t = { type: "text", answer: "x^2+1", accept: ["1+x^2"] };
  assert.equal(L.checkTask(t, "X**2 + 1"), true);
  assert.equal(L.checkTask(t, "1 + x^2"), true);
  assert.equal(L.checkTask(t, "x^2-1"), false);
  assert.equal(L.checkTask({ type: "text", answer: "Парабола" }, " парабола. "), true);
  assert.equal(L.checkTask({ type: "text", answer: "ёлка" }, "елка"), true);
});

/* ---------- Даты ---------- */
test("isoWeekKey", () => {
  assert.equal(L.isoWeekKey(new Date(2026, 10, 13)), "2026-W46");
  assert.equal(L.isoWeekKey(new Date(2026, 0, 1)), "2026-W01");
  assert.equal(L.isoWeekKey(new Date(2024, 11, 30)), "2025-W01");
  assert.equal(L.isoWeekKey(new Date(2021, 0, 3)), "2020-W53");
  assert.equal(L.isoWeekKey(new Date(2026, 10, 15)), L.isoWeekKey(new Date(2026, 10, 9)));   // вс и пн одной недели
  assert.notEqual(L.isoWeekKey(new Date(2026, 10, 15)), L.isoWeekKey(new Date(2026, 10, 16)));
});
test("daysBetween и ymd", () => {
  assert.equal(L.daysBetween("2026-02-27", "2026-03-02"), 3);
  assert.equal(L.daysBetween("2026-12-31", "2027-01-01"), 1);
  assert.equal(L.ymd(new Date(2026, 10, 9)), "2026-11-09");
});

/* ---------- Экзамен: следующий бесплатный через 7 дней ---------- */
const DAY = 86400000;
test("canTakeExam: 7 дней после прошлого", () => {
  const t0 = Date.UTC(2026, 10, 10, 12);
  const st = { exams: { algebra: t0 } };
  assert.equal(L.canTakeExam(st, "algebra", false, t0 + 6 * DAY + 23 * 3600000), false);
  assert.equal(L.canTakeExam(st, "algebra", false, t0 + 7 * DAY), true);
  assert.equal(L.canTakeExam(st, "russian", false, t0), true, "другой предмет не затронут");
  assert.equal(L.canTakeExam(st, "algebra", true, t0), true, "премиум без ограничений");
  assert.equal(L.nextExamAt(st, "algebra"), t0 + 7 * DAY);
  assert.equal(L.nextExamAt({}, "algebra"), 0);
  assert.equal(L.canTakeExam({ exams: { algebra: "2026-W46" } }, "algebra", false, t0), true, "старый формат (неделя) не блокирует");
});

/* ---------- Смена бесплатного предмета ---------- */
test("смена бесплатного предмета: не раньше чем через 14 дней", () => {
  const t0 = Date.UTC(2026, 10, 1);
  assert.equal(L.canChangeElective({ elective: null, electiveAt: 0 }, t0), true);
  const st = { elective: "biology", electiveAt: t0 };
  assert.equal(L.canChangeElective(st, t0 + 13 * DAY), false);
  assert.equal(L.canChangeElective(st, t0 + 14 * DAY), true);
  assert.equal(L.electiveChangeAt(st), t0 + 14 * DAY);
  assert.equal(L.canChangeElective({ elective: "biology" }, t0), true, "старое сохранение без даты");
});

/* ---------- Стрик и заморозки (раз в месяц) ---------- */
test("стрик: подряд и повтор в тот же день", () => {
  let s = { count: 0, best: 0, last: null };
  s = L.completeDay(s, "2026-11-10", false); assert.equal(s.count, 1);
  s = L.completeDay(s, "2026-11-10", false); assert.equal(s.count, 1, "повторно в тот же день не растёт");
  s = L.completeDay(s, "2026-11-11", false); assert.equal(s.count, 2);
  assert.equal(L.streakStatus(s, "2026-11-12", false), "ok", "вчера выполнено — всё хорошо");
});

test("стрик: бесплатная заморозка раз в месяц восстанавливает серию при следующем прохождении", () => {
  let s = L.completeDay(L.completeDay({}, "2026-11-10", false), "2026-11-11", false);   // серия 2
  // пропущено 12, 13 → в 14-е серия под защитой
  let info = L.streakInfo(s, "2026-11-14", false);
  assert.equal(info.status, "saveable"); assert.equal(info.count, 2); assert.equal(info.freezesLeft, 1);
  s = L.completeDay(s, "2026-11-14", false);
  assert.equal(s.count, 3, "серия продолжилась с +1");
  assert.equal(s.lf, "2026-11-14");
  assert.equal(L.streakInfo(s, "2026-11-15", false).freezesLeft, 0, "заморозка потрачена");
  // второй пропуск в том же месяце — серия сгорает
  assert.equal(L.streakStatus(s, "2026-11-18", false), "lost");
  assert.equal(L.streakInfo(s, "2026-11-18", false).count, 0);
  const r = L.completeDay(s, "2026-11-18", false);
  assert.equal(r.count, 1); assert.equal(r.best, 3, "рекорд сохраняется");
  // в новом месяце заморозка снова есть
  assert.equal(L.streakStatus(s, "2026-12-02", false), "lost", "слишком длинный пропуск (16 дней)");
  const s2 = { count: 5, best: 5, last: "2026-11-28", fm: "2026-11", fu: 1 };
  assert.equal(L.streakStatus(s2, "2026-12-01", false), "saveable", "1 декабря — новая заморозка");
});

test("стрик: длина пропуска, который закрывает заморозка (3 дня бесплатно, 14 в премиуме)", () => {
  const s = { count: 4, best: 4, last: "2026-11-10" };
  assert.equal(L.streakStatus(s, "2026-11-14", false), "saveable");   // пропущено 3
  assert.equal(L.streakStatus(s, "2026-11-15", false), "lost");        // пропущено 4
  assert.equal(L.streakStatus(s, "2026-11-25", true), "saveable");     // пропущено 14
  assert.equal(L.streakStatus(s, "2026-11-26", true), "lost");         // пропущено 15
});

test("стрик: в премиуме 3 заморозки в месяц", () => {
  assert.equal(L.freezesPerMonth(true), 3);
  assert.equal(L.freezesPerMonth(false), 1);
  let s = { count: 10, best: 10, last: "2026-11-01" };
  for (const day of ["2026-11-04", "2026-11-08", "2026-11-12"]) {
    assert.equal(L.streakStatus(s, day, true), "saveable", day);
    s = L.completeDay(s, day, true);
  }
  assert.equal(s.count, 13);
  assert.equal(L.freezesLeft(s, "2026-11-13", true), 0);
  assert.equal(L.streakStatus(s, "2026-11-16", true), "lost", "четвёртой заморозки нет");
});

test("стрик: серия, сгоревшая и не возобновлённая, показывается как 0, рекорд остаётся", () => {
  const s = { count: 7, best: 9, last: "2026-10-01" };
  const info = L.streakInfo(s, "2026-11-14", false);
  assert.equal(info.status, "lost"); assert.equal(info.count, 0); assert.equal(info.best, 9);
});

test("режимы стрика", () => {
  const m = L.RULES.STREAK_MODES;
  assert.deepEqual([m.easy.n, m.medium.n, m.hard.n], [1, 2, 3]);
  assert.equal(L.defaultState().streakMode, "easy");
  assert.deepEqual(L.defaultState().streakSubjects, ["algebra"]);
});

/* ---------- Ежедневные задания ---------- */
function fakeTopic(id, nq = 33, nt = 33) {
  const mk = (kind, n) => Array.from({ length: n }, (_, i) => ({ key: `${id}:x.${kind}${i}`, topicId: id, kind, data: { text: `${id} ${kind}${i}` } }));
  return { id, passedAt: 0, pool: { questions: mk("q", nq), tasks: mk("t", nt) } };
}
test("pickDaily: 5+5, без повторов, детерминировано", () => {
  const a = Object.assign(fakeTopic("t1"), { passedAt: 1 });
  const b = Object.assign(fakeTopic("t2"), { passedAt: 2 });
  const r1 = L.pickDaily({ learned: [a, b], seed: "2026-11-13|7|algebra", errors: {} });
  const r2 = L.pickDaily({ learned: [b, a], seed: "2026-11-13|7|algebra", errors: {} });
  assert.deepEqual(r1.items.map(x => x.key), r2.items.map(x => x.key), "порядок learned не влияет");
  assert.equal(r1.items.filter(x => x.kind === "q").length, 5);
  assert.equal(r1.items.filter(x => x.kind === "t").length, 5);
  assert.equal(new Set(r1.items.map(x => x.key)).size, 10);
  const r3 = L.pickDaily({ learned: [a, b], seed: "2026-11-14|7|algebra", errors: {} });
  assert.notDeepEqual(r1.items.map(x => x.key), r3.items.map(x => x.key));
});
test("pickDaily: около 60% про последнюю тему", () => {
  const a = Object.assign(fakeTopic("old"), { passedAt: 1 });
  const b = Object.assign(fakeTopic("new"), { passedAt: 2 });
  let latest = 0, total = 0;
  for (let i = 0; i < 300; i++) {
    const r = L.pickDaily({ learned: [a, b], seed: "s" + i, errors: {} });
    r.items.forEach(x => { total++; if (x.topicId === "new") latest++; });
  }
  const share = latest / total;
  assert.ok(share > 0.55 && share < 0.65, "доля " + share);
});
test("pickDaily: день повторения берёт только старые темы; одна тема — её же", () => {
  const a = Object.assign(fakeTopic("old"), { passedAt: 1 });
  const b = Object.assign(fakeTopic("new"), { passedAt: 2 });
  const r = L.pickDaily({ learned: [a, b], seed: "rv", errors: {}, review: true });
  assert.ok(r.items.every(x => x.topicId === "old"));
  assert.equal(r.mode, "review");
  const solo = L.pickDaily({ learned: [b], seed: "rv", errors: {}, review: true });
  assert.ok(solo.items.length === 10 && solo.items.every(x => x.topicId === "new"));
});
test("pickDaily: ошибочные задания выпадают чаще", () => {
  const a = Object.assign(fakeTopic("old", 20, 20), { passedAt: 1 });
  const b = Object.assign(fakeTopic("new", 20, 20), { passedAt: 2 });
  const errors = { "old:x.q0": 3, "old:x.t0": 3 };
  let hits = 0, base = 0;
  for (let i = 0; i < 400; i++) {
    const r = L.pickDaily({ learned: [a, b], seed: "e" + i, errors, review: true });
    hits += r.items.filter(x => x.key === "old:x.q0" || x.key === "old:x.t0").length;
    base += r.items.filter(x => x.key === "old:x.q1" || x.key === "old:x.t1").length;
  }
  assert.ok(hits > base * 2, `ошибочные ${hits}, обычные ${base}`);
});
test("pickDaily: нет пройденных тем", () => {
  assert.equal(L.pickDaily({ learned: [], seed: "x" }).needLearn, true);
});
test("pickDaily: мало заданий — не падает", () => {
  const a = Object.assign(fakeTopic("tiny", 2, 1), { passedAt: 1 });
  const r = L.pickDaily({ learned: [a], seed: "z", errors: {} });
  assert.equal(r.items.length, 3);
});

/* ---------- Темы и экзамены ---------- */
function mkTopic() {
  const q = (n) => Array.from({ length: n }, (_, i) => ({ text: "q" + i, options: ["a", "b", "c", "d"], correct: 0, explain: "e" }));
  const t = (n) => Array.from({ length: n }, (_, i) => ({ text: "t" + i, type: "number", answer: String(i), solution: "s" }));
  return { id: "x1", practice: { questions: q(3), tasks: t(3) }, exams: [0, 1, 2].map(() => ({ questions: q(10), tasks: t(10) })) };
}
test("flattenTopic / practiceItems / examItems", () => {
  const tp = mkTopic();
  const f = L.flattenTopic(tp);
  assert.equal(f.questions.length, 33); assert.equal(f.tasks.length, 33);
  assert.equal(new Set(f.questions.concat(f.tasks).map(x => x.key)).size, 66);
  assert.equal(L.practiceItems(tp).length, 6);
  const e0 = L.examItems(tp, 0), e1 = L.examItems(tp, 1), e3 = L.examItems(tp, 3);
  assert.equal(e0.length, 20);
  assert.notEqual(e0[0].key, e1[0].key);
  assert.equal(e0[0].key, e3[0].key, "по кругу");
  assert.equal(L.subjectExamItems([tp, Object.assign(mkTopic(), { id: "x2" })], "s").length, 20);
});

/* ---------- Коды (кросс-проверка с Python-подписью) ---------- */
function pyCode(args) {
  const botDir = path.resolve(__dirname, "../../bot");
  const script = `
import sys, json
sys.path.insert(0, ${JSON.stringify(botDir)})
import codes, ed25519
seed = bytes(range(32))
pub = ed25519.public_key(seed)
a = json.loads(sys.argv[1])
out = {"pub": codes.b64u(pub), "code": codes.make_code(seed, a["u"], a["k"], subject=a.get("s"), exp=a.get("e"), nonce=a.get("n"))}
print(json.dumps(out))`;
  const r = spawnSync("python3", ["-I", "-c", script, JSON.stringify(args)], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}
test("verifyCode: подпись Python проверяется в JS", () => {
  const now = 1800000000;
  const p = pyCode({ u: 555, k: "p", e: now + 1000 });
  assert.equal(L.verifyCode(p.code, p.pub, nacl, 555, now).ok, true);
  assert.equal(L.verifyCode(p.code, p.pub, nacl, 556, now).reason, "user");
  assert.equal(L.verifyCode(p.code, p.pub, nacl, 555, now + 2000).reason, "expired");
  const tampered = p.code.slice(0, 10) + (p.code[10] === "A" ? "B" : "A") + p.code.slice(11);
  assert.equal(L.verifyCode(tampered, p.pub, nacl, 555, now).ok, false);
  const other = pyCode({ u: 555, k: "p", e: now + 1000 });
  assert.equal(L.verifyCode(other.code, "A".repeat(43), nacl, 555, now).ok, false);
  assert.equal(L.verifyCode("мусор", p.pub, nacl, 555, now).ok, false);
  assert.equal(L.verifyCode("", p.pub, nacl, 555, now).ok, false);
});
test("computeEntitlements", () => {
  const now = 1800000000;
  const prem = pyCode({ u: 9, k: "p", e: now + 100 });
  const subj = pyCode({ u: 9, k: "s", s: "physics" });
  const car = pyCode({ u: 9, k: "c", n: "abc123" });
  const stranger = pyCode({ u: 10, k: "s", s: "chemistry" });
  const old = pyCode({ u: 9, k: "p", e: now - 5 });
  const ent = L.computeEntitlements([prem.code, subj.code, car.code, stranger.code, old.code, "junk"], prem.pub, nacl, 9, now);
  assert.equal(ent.premiumUntil, now + 100);
  assert.deepEqual(ent.subjects, { physics: true });
  assert.deepEqual(ent.career, ["abc123"]);
  assert.equal(L.isPremium(ent, now), true);
  assert.equal(L.isPremium(ent, now + 101), false);
});

/* ---------- Доступ к предметам ---------- */
test("subjectAccess", () => {
  const noEnt = { premiumUntil: 0, subjects: {}, career: [] };
  const now = 1;
  const alg = { id: "algebra", tier: "free" }, bio = { id: "biology", tier: "elective" }, eng = { id: "english", tier: "elective" }, phy = { id: "physics", tier: "paid" };
  let st = L.defaultState();
  assert.equal(L.subjectAccess(alg, st, noEnt, now), "open");
  assert.equal(L.subjectAccess(bio, st, noEnt, now), "choose");
  assert.equal(L.subjectAccess(phy, st, noEnt, now), "locked");
  st.elective = "biology";
  assert.equal(L.subjectAccess(bio, st, noEnt, now), "open");
  assert.equal(L.subjectAccess(eng, st, noEnt, now), "locked");
  assert.equal(L.subjectAccess(eng, st, { premiumUntil: 0, subjects: { english: true }, career: [] }, now), "open");
  assert.equal(L.subjectAccess(phy, st, { premiumUntil: 100, subjects: {}, career: [] }, now), "open");
});

/* ---------- Профориентация ---------- */
test("scoreCareer / encode / decode", () => {
  const items = [];
  for (let i = 0; i < 30; i++) items.push({ t: "RIASEC"[i % 6] });
  const answers = items.map((it) => (it.t === "I" ? 5 : it.t === "A" ? 4 : 1));
  const r = L.scoreCareer(items, answers);
  assert.equal(r.pct.I, 100); assert.equal(r.pct.A, 80); assert.equal(r.pct.R, 20);
  assert.deepEqual(r.top.slice(0, 2), ["I", "A"]);
  const enc = L.encodeAnswers(answers, 30);
  assert.equal(enc.length, 30);
  assert.deepEqual(L.decodeAnswers(enc), answers);
  assert.equal(L.encodeAnswers([1, 2], 4), "1200");
  assert.ok(L.scoreCareer(items, []).top.length === 3, "пустые ответы не ломают");
});

/* ---------- Безопасный вывод ---------- */
test("renderRich экранирует HTML и поддерживает **жирный** и списки", () => {
  const h = L.renderRich('<img src=x onerror=alert(1)> **важно**\n- один\n- два\n`x^2`');
  assert.ok(!h.includes("<img"));
  assert.ok(h.includes("&lt;img"));
  assert.ok(h.includes("<b>важно</b>"));
  assert.ok(h.includes("<ul><li>один</li><li>два</li></ul>"));
  assert.ok(h.includes("<code>x^2</code>"));
});

test("pruneState ограничивает размер", () => {
  const st = L.defaultState();
  for (let i = 0; i < 30; i++) st.daily["2026-10-" + String(i + 1).padStart(2, "0")] = {};
  for (let i = 0; i < 700; i++) st.errors["k" + i] = (i % 3) + 1;
  L.pruneState(st);
  assert.equal(Object.keys(st.daily).length, 14);
  assert.equal(Object.keys(st.errors).length, 600);
});
