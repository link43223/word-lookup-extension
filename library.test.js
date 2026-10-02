"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "service-worker.js"), "utf8");
const META = "library-meta:state";
const STATUS = "library-meta:backup";
const copy = value => JSON.parse(JSON.stringify(value));
const entry = (word, text = "释义") => ({ at: 1, data: { word, headword: word, us: "test",
  lines: ["n. " + text, "v. 保留", "n. " + text],
  meanings: [{ pos: "n", text }, { pos: "v", text: "保留" }, { pos: "n", text }],
  futureField: { keep: ["原样保存", 1] } } });
const backup = records => ({ format: "word-lookup-personal-library", version: 1,
  entries: Object.entries(records).map(([key, value]) => ({ key, value })) });
const tick = () => new Promise(resolve => setImmediate(resolve));

function worker(records = {}, options = {}) {
  let listener, alarmListener;
  const alarms = new Map();
  const runtime = {
    getURL: file => "chrome-extension://test/" + file,
    onMessage: { addListener(fn) { listener = fn; } },
    onInstalled: { addListener() {} }, onStartup: { addListener() {} }
  };
  const context = vm.createContext({
    chrome: { runtime, storage: { local: {
      async get(keys) {
        const selected = keys === null ? records : Object.fromEntries(
          (Array.isArray(keys) ? keys : [keys]).filter(key => records[key] !== undefined).map(key => [key, records[key]]));
        return copy(selected);
      },
      async getKeys() { return Object.keys(records); },
      async set(items) { if (options.set) await options.set(items); Object.assign(records, copy(items)); },
      async remove(keys) { for (const key of keys) delete records[key]; },
      async getBytesInUse() { return JSON.stringify(records).length; }
    }, ...(options.session ? { session: {
      async get() { return copy(options.session); },
      async set(items) { Object.assign(options.session, copy(items)); },
      async remove(key) { delete options.session[key]; }
    } } : {}) }, alarms: {
      onAlarm: { addListener(fn) { alarmListener = fn; } },
      async create(name, details) { alarms.set(name, details); },
      async clear(name) { return alarms.delete(name); }
    } },
    AbortController, setTimeout, clearTimeout,
    fetch: options.fetch || (async () => { throw new Error("must not use network"); }),
    testHandle: options.handle || null
  });
  vm.runInContext(source, context);
  vm.runInContext("getBackupHandle = async () => testHandle", context);
  return {
    context, records, alarms,
    run(code) { return vm.runInContext(code, context); },
    call(message, sender = { url: "chrome-extension://test/library.html" }) {
      return new Promise(resolve => listener(message, sender, resolve));
    },
    alarm() { alarmListener({ name: "library-backup" }); }
  };
}

function fileHandle(options = {}) {
  const snapshots = [];
  let active = 0, maximum = 0, aborted = 0;
  const handle = {
    name: "词库.json",
    async queryPermission() { return options.permission || "granted"; },
    async createWritable() {
      active++;
      maximum = Math.max(active, maximum);
      let value;
      return {
        async write(text) { if (options.write) await options.write(text); value = text; },
        async close() { if (options.close) await options.close(); snapshots.push(JSON.parse(value)); active--; },
        async abort() { aborted++; active--; }
      };
    }
  };
  return { handle, snapshots, maximum: () => maximum, aborted: () => aborted };
}

test("export, uninstall simulation and restore keep every field, duplicate and sense order", async () => {
  const original = entry("reserve", "储备；储藏");
  const first = worker({ "library:v1:reserve": original });
  const exported = await first.call({ type: "library-export" });
  assert.equal(exported.ok, true);
  const fresh = worker();
  const imported = await fresh.call({ type: "library-import", backup: exported.backup });
  assert.equal(imported.added, 1);
  const restarted = worker(fresh.records);
  const result = await restarted.run("lookup('reserve')");
  assert.deepEqual(copy(result), original.data);
  assert.equal((await restarted.call({ type: "library-status" })).count, 1);
});

test("restore only adds missing words and never overwrites a local definition", async () => {
  const original = entry("reserve", "本地版本");
  const app = worker({ "library:v1:reserve": original });
  const response = await app.call({ type: "library-import",
    backup: backup({ "library:v1:reserve": entry("reserve", "文件版本"), "library:v1:keep": entry("keep") }) });
  assert.equal(response.added, 1);
  assert.equal(response.skipped, 1);
  assert.deepEqual(app.records["library:v1:reserve"], original);
  assert.equal(app.records[META].dirty, true);
});

test("invalid or duplicate entries reject the whole restore without partial writes", async () => {
  for (const invalid of [
    { key: "library:v1:bad", value: { at: 1, data: { lines: "not an array" } } },
    { key: "other:settings", value: entry("bad") },
    { key: "library:v1:reserve", value: entry("reserve") },
    { key: "library:v1:bad:extra", value: entry("bad") },
    { key: "library:v1:bad", value: { at: 1, data: { lines: ["n. x"], meanings: [null] } } }
  ]) {
    const app = worker();
    const data = backup({ "library:v1:reserve": entry("reserve") });
    data.entries.push(invalid);
    const result = await app.call({ type: "library-import", backup: data });
    assert.equal(result.ok, false);
    assert.deepEqual(app.records, {});
  }
});

test("management commands reject content-script senders", async () => {
  const app = worker();
  const response = await app.call({ type: "library-import", backup: backup({ "library:v1:test": entry("test") }) },
    { url: "https://example.com/", tab: { url: "https://example.com/" } });
  assert.equal(response.ok, false);
  assert.deepEqual(app.records, {});
});

test("a late online answer cannot overwrite a word restored while the query was running", async () => {
  let release;
  const app = worker({}, { fetch: () => new Promise(resolve => { release = () => resolve({ ok: true,
    json: async () => ({ ec: { word: [{ headword: "reserve", usphone: "remote",
      trs: [{ tr: [{ l: { i: ["n. 网络版本"] } }] }] }] } }) }); }) });
  const pending = app.run("lookup('reserve')");
  await tick();
  const original = entry("reserve", "备份中的完整版本");
  await app.call({ type: "library-import", backup: backup({ "library:v1:reserve": original }) });
  release();
  assert.deepEqual(copy(await pending), original.data);
  assert.deepEqual(app.records["library:v1:reserve"], original);
});

test("restore supplies a missing word even if an older online query fails afterwards", async () => {
  let rejectFetch;
  let attempts = 0;
  const app = worker({}, { fetch: () => ++attempts === 1
    ? new Promise((_, reject) => { rejectFetch = reject; }) : Promise.reject(new Error("offline")) });
  const pending = app.run("lookup('reserve')");
  await tick();
  const original = entry("reserve");
  await app.call({ type: "library-import", backup: backup({ "library:v1:reserve": original }) });
  rejectFetch(new Error("offline"));
  assert.deepEqual(copy(await pending), original.data);
});

test("a failed save keeps the definition available and retries without querying again", async () => {
  let fail = true, requests = 0;
  const app = worker({}, {
    set: async items => { if (fail && items["library:v1:test"]) throw new Error("disk full"); },
    fetch: async () => { requests++; return { ok: true, json: async () => ({ ec: { word: [
      { headword: "test", usphone: "test", trs: [{ tr: [{ l: { i: ["n. 测试"] } }] }] }
    ] } }) }; }
  });
  const result = await app.run("lookup('test')");
  assert.equal(result.meanings[0].text, "测试");
  await app.run("flushLibraryWrites()");
  assert.equal(app.records["library:v1:test"], undefined);
  const status = await app.call({ type: "library-status" });
  assert.equal(status.count, 0);
  assert.equal(status.save.state, "error");
  assert.equal(status.save.count, 1);
  assert.ok(app.alarms.has("library-save-retry"));
  fail = false;
  await app.run("lookup('test')");
  await app.run("flushLibraryWrites()");
  assert.ok(app.records["library:v1:test"]);
  assert.equal(requests, 1);
  assert.equal(app.alarms.has("library-save-retry"), false);
  assert.equal((await app.call({ type: "library-status" })).save.state, "saved");
});

test("pending writes survive a worker restart through a separate session journal", async () => {
  const session = {};
  const records = {};
  const first = worker(records, { session, set: async items => {
    if (items["library:v1:reserve"]) throw new Error("disk temporarily unavailable");
  } });
  first.context.original = entry("reserve");
  first.run("queueLibraryWrite('library:v1:reserve', original)");
  await first.run("flushLibraryWrites()");
  assert.ok(session["library-pending:v1:reserve"]);
  assert.equal(records["library:v1:reserve"], undefined);
  const restarted = worker(records, { session });
  await tick();
  await restarted.run("flushLibraryWrites()");
  assert.deepEqual(records["library:v1:reserve"], entry("reserve"));
  assert.deepEqual(session, {});
  assert.deepEqual(copy(await restarted.run("lookup('reserve')")), entry("reserve").data);
});

test("a stalled unrelated library mutation cannot delay an online answer", async () => {
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const app = worker({}, { fetch: async () => ({ ok: true, json: async () => ({ ec: { word: [
    { headword: "test", usphone: "test", trs: [{ tr: [{ l: { i: ["n. 测试"] } }] }] }
  ] } }) }) });
  app.context.waitForDisk = wait;
  app.run("withLibraryWrite(() => waitForDisk)");
  try {
    const result = await Promise.race([app.run("lookup('test')"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("lookup blocked on disk queue")), 100))]);
    assert.equal(result.meanings[0].text, "测试");
    assert.equal(app.records["library:v1:test"], undefined);
  } finally { release(); }
  await app.run("flushLibraryWrites()");
  assert.ok(app.records["library:v1:test"]);
});

test("restored data wins over an older definition queued for background saving", async () => {
  const app = worker();
  app.context.original = entry("reserve", "尚未保存的网络结果");
  app.run("queueLibraryWrite('library:v1:reserve', original)");
  const restored = entry("reserve", "备份版本");
  await app.call({ type: "library-import", backup: backup({ "library:v1:reserve": restored }) });
  assert.deepEqual(copy(await app.run("lookup('reserve')")), restored.data);
  await app.run("flushLibraryWrites()");
  assert.deepEqual(app.records["library:v1:reserve"], restored);
  assert.deepEqual(copy(await app.run("lookup('reserve')")), restored.data);
});

test("a stale session journal cannot mask an already restored permanent definition", async () => {
  const original = entry("reserve", "已恢复");
  const session = { "library-pending:v1:reserve": entry("reserve", "旧网络结果") };
  const app = worker({ "library:v1:reserve": original }, { session });
  await tick();
  assert.deepEqual(copy(await app.run("lookup('reserve')")), original.data);
  assert.deepEqual(session, {});
});

test("a successful file backup records filename, count and time only after close", async () => {
  const file = fileHandle();
  const app = worker({ "library:v1:test": entry("test"), [META]: { revision: 4, dirty: true } }, { handle: file.handle });
  const result = await app.call({ type: "backup-now" });
  assert.equal(result.state, "saved");
  assert.equal(result.count, 1);
  assert.equal(result.filename, "词库.json");
  assert.ok(result.lastSuccessAt > 0);
  assert.deepEqual(file.snapshots[0].entries[0].value, app.records["library:v1:test"]);
  assert.equal(app.records[META].dirty, false);
});

test("denied file permission is visible and leaves local data pending backup", async () => {
  const file = fileHandle({ permission: "prompt" });
  const app = worker({ "library:v1:test": entry("test"), [META]: { revision: 1, dirty: true } }, { handle: file.handle });
  const result = await app.call({ type: "backup-now" });
  assert.equal(result.state, "permission");
  assert.equal(app.records[STATUS].state, "permission");
  assert.equal(app.records[META].dirty, true);
  assert.equal(file.snapshots.length, 0);
});

test("file failure preserves the old success time and an alarm retries after a worker restart", async () => {
  let fail = true;
  const file = fileHandle({ write: async () => { if (fail) throw new Error("disk full"); } });
  const app = worker({ "library:v1:test": entry("test"), [STATUS]: { state: "saved", lastSuccessAt: 123 },
    [META]: { revision: 2, dirty: false } }, { handle: file.handle });
  const result = await app.call({ type: "backup-now" });
  assert.equal(result.ok, false);
  assert.equal(app.records[STATUS].state, "error");
  assert.equal(app.records[STATUS].lastSuccessAt, 123);
  assert.equal(app.records[META].dirty, true);
  assert.equal(app.alarms.get("library-backup").periodInMinutes, 5);
  assert.equal(file.aborted(), 1);
  fail = false;
  const restarted = worker(app.records, { handle: file.handle });
  restarted.alarm();
  await tick();
  assert.equal(app.records[STATUS].state, "saved");
  assert.equal(app.records[META].dirty, false);
  assert.equal(file.snapshots.length, 1);
});

test("manual and automatic backups never open concurrent writers", async () => {
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const file = fileHandle({ close: () => wait });
  const app = worker({ "library:v1:test": entry("test"), [META]: { revision: 1, dirty: true } }, { handle: file.handle });
  const first = app.run("requestBackup()");
  await tick();
  const second = app.run("requestBackup(true)");
  release();
  await Promise.all([first, second]);
  assert.equal(file.maximum(), 1);
  assert.equal(file.snapshots.length, 2);
  assert.equal(app.records[META].dirty, false);
});

test("a word saved during file writing is included in a following snapshot", async () => {
  let release, closes = 0;
  const wait = new Promise(resolve => { release = resolve; });
  const file = fileHandle({ close: () => ++closes === 1 ? wait : Promise.resolve() });
  const app = worker({ "library:v1:first": entry("first"), [META]: { revision: 1, dirty: true } }, { handle: file.handle });
  const pending = app.run("requestBackup()");
  await tick();
  app.context.newEntry = entry("second");
  await app.run("storeLibrary('library:v1:second', newEntry)");
  release();
  await pending;
  assert.equal(file.snapshots.length, 2);
  assert.equal(file.snapshots[1].entries.length, 2);
  assert.equal(app.records[STATUS].count, 2);
  assert.equal(app.records[META].dirty, false);
});

test("an unconfigured backup is never reported as successful", async () => {
  const app = worker({ [STATUS]: { state: "saved", count: 9 } });
  const result = await app.call({ type: "backup-now" });
  assert.equal(result.state, "unconfigured");
  assert.equal(app.records[STATUS].state, "unconfigured");
  assert.equal(app.records[META].dirty, true);
});

test("the backup page waits for the handle transaction to commit", async () => {
  let transaction;
  const fakeDB = { close() {}, transaction() {
    transaction = { objectStore: () => ({ put: () => ({ result: "request success only" }) }) };
    return transaction;
  } };
  const context = vm.createContext({
    document: { querySelector: () => ({ addEventListener() {} }) },
    chrome: { storage: { onChanged: { addListener() {} } } },
    window: { addEventListener() {} },
    fakeDB
  });
  const page = fs.readFileSync(path.join(__dirname, "library-page.js"), "utf8").replace(/void refreshStatus\(\);\s*$/, "");
  vm.runInContext(page, context);
  vm.runInContext("openBackupDatabase = async () => fakeDB", context);
  let completed = false;
  const pending = vm.runInContext("accessHandle({ name: 'test.json' })", context).then(() => { completed = true; });
  await tick();
  assert.equal(completed, false);
  transaction.oncomplete();
  await pending;
  assert.equal(completed, true);
});
