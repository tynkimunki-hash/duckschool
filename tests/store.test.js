const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../js/store.js");

function bigState(n) {
  const errors = {};
  for (let i = 0; i < n; i++) errors["алгебра-тема-" + i + ":e1.q" + i] = i % 4;
  return { v: 1, errors, note: "Кириллица ✓ и эмодзи 🔥" };
}

test("сохранение и загрузка большого состояния кусками", async () => {
  const cloud = S.memoryAdapter("cloud");
  const st = S.createStore({ adapters: [cloud], delay: 0 });
  const obj = bigState(900);
  await st.save(obj);
  const keys = Object.keys(cloud.data).filter(k => k.startsWith("ep1_") && k !== "ep1_n");
  assert.ok(keys.length > 2, "несколько кусков: " + keys.length);
  assert.ok(keys.every(k => cloud.data[k].length <= S.CHUNK));
  const back = await S.createStore({ adapters: [cloud] }).load();
  assert.deepEqual(back.errors, obj.errors);
  assert.equal(back.note, obj.note);
});

test("уменьшение состояния удаляет лишние куски", async () => {
  const cloud = S.memoryAdapter("cloud");
  const st = S.createStore({ adapters: [cloud] });
  await st.save(bigState(900));
  const before = Object.keys(cloud.data).length;
  await st.save(bigState(5));
  const after = Object.keys(cloud.data).length;
  assert.ok(after < before);
  const back = await S.createStore({ adapters: [cloud] }).load();
  assert.equal(Object.keys(back.errors).length, 5);
});

test("берётся более свежая копия; битая копия игнорируется", async () => {
  const cloud = S.memoryAdapter("cloud"), local = S.memoryAdapter("local");
  await S.createStore({ adapters: [local] }).save({ v: 1, who: "local" });
  await new Promise(r => setTimeout(r, 5));
  await S.createStore({ adapters: [cloud] }).save({ v: 1, who: "cloud" });
  assert.equal((await S.createStore({ adapters: [cloud, local] }).load()).who, "cloud");
  cloud.data["ep1_0"] = "{не json";                        // порча в облаке
  assert.equal((await S.createStore({ adapters: [cloud, local] }).load()).who, "local");
});

test("недоступное облако не ломает сохранение: локальная копия остаётся", async () => {
  const cloud = S.memoryAdapter("cloud", true), local = S.memoryAdapter("local");
  const st = S.createStore({ adapters: [cloud, local] });
  await st.save({ v: 1, x: 1 });
  assert.equal((await S.createStore({ adapters: [cloud, local] }).load()).x, 1);
});

test("пустое хранилище -> null", async () => {
  assert.equal(await S.createStore({ adapters: [S.memoryAdapter("a")] }).load(), null);
});

test("schedule сохраняет последнее состояние одним разом", async () => {
  const cloud = S.memoryAdapter("cloud");
  let writes = 0; const origSet = cloud.set; cloud.set = function (k, v) { if (k === "ep1_n") writes++; return origSet.call(this, k, v); };
  const st = S.createStore({ adapters: [cloud], delay: 10 });
  const state = { v: 1, n: 0 };
  for (let i = 1; i <= 5; i++) { state.n = i; st.schedule(() => state); }
  await new Promise(r => setTimeout(r, 40));
  await st.flush();
  assert.equal(writes, 1);
  assert.equal((await S.createStore({ adapters: [cloud] }).load()).n, 5);
});

test("flush без ожидающих изменений безопасен", async () => {
  await S.createStore({ adapters: [S.memoryAdapter("a")] }).flush();
});

test("cloudAdapter работает поверх колбэчного CloudStorage", async () => {
  const mem = {};
  const tg = { CloudStorage: {
    getItems: (keys, cb) => { const o = {}; keys.forEach(k => { if (k in mem) o[k] = mem[k]; }); setTimeout(() => cb(null, o), 0); },
    setItem: (k, v, cb) => { mem[k] = v; setTimeout(() => cb(null, true), 0); },
    removeItems: (keys, cb) => { keys.forEach(k => delete mem[k]); setTimeout(() => cb(null, true), 0); }
  } };
  const a = S.cloudAdapter(tg);
  const st = S.createStore({ adapters: [a] });
  await st.save({ v: 1, hello: "мир" });
  assert.equal((await S.createStore({ adapters: [S.cloudAdapter(tg)] }).load()).hello, "мир");
  assert.equal(S.cloudAdapter({}), null);
  assert.equal(S.cloudAdapter(undefined), null);
});
