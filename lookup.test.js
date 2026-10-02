"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function dictionary(entries, failingQueries = []) {
  const requests = [];
  let localLoads = 0;
  const records = {};
  const context = vm.createContext({
    chrome: {
      runtime: { onMessage: { addListener() {} }, getURL: file => "chrome-extension://test/" + file },
      storage: { local: {
        async get(keys) { return keys === null ? { ...records } : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, records[key]])); },
        async set(items) { Object.assign(records, items); }
      } }
    },
    AbortController,
    setTimeout,
    clearTimeout,
    fetch: async url => {
      if (url.startsWith("chrome-extension://")) {
        localLoads++;
        return { ok: true, text: async () =>
          "engulfed\t/ɪnˈɡəɫft/\nmorning\t/ˈmɔɹnɪŋ/\nlearned\t/ˈɫɝnd/, /ˈɫɝnɪd/\n" };
      }
      const query = new URL(url).searchParams.get("q");
      requests.push(query);
      if (failingQueries.includes(query)) throw new Error("Network unavailable");
      const definition = entries[query];
      const entry = typeof definition === "string" ? { text: definition } : definition;
      const body = url.includes("/jsonapi")
        ? { ec: entry ? { word: [{ headword: query, usphone: entry.us || "", ukphone: entry.uk || "",
          trs: [{ tr: [{ l: { i: [entry.text] } }] }] }] } : null,
          simple: entry?.simpleUs ? { query, word: [{ usphone: entry.simpleUs }] } : null }
        : { data: { entries: [] } };
      return { ok: true, json: async () => body };
    }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "service-worker.js"), "utf8"), context);
  return { lookup: (word, surface = word) => vm.runInContext(
    `lookupOnline(${JSON.stringify(word)}, ${JSON.stringify(surface)})`, context),
    lookupWithDeadline: (word, deadline) => vm.runInContext(
      `lookupOnline(${JSON.stringify(word)}, ${JSON.stringify(word)}, ${deadline})`, context),
    lookupCached: word => vm.runInContext(`lookup(${JSON.stringify(word)})`, context),
    parse: lines => JSON.parse(vm.runInContext(`JSON.stringify(parseMeanings(${JSON.stringify(lines)}))`, context)),
    requests, localLoads: () => localLoads };
}

test("hover wakeup responds locally without any network request", async () => {
  let listener;
  const requests = [];
  const context = vm.createContext({
    chrome: { runtime: { onMessage: { addListener(fn) { listener = fn; } } } },
    AbortController, setTimeout, clearTimeout,
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(0) };
    }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "service-worker.js"), "utf8"), context);
  const warm = () => new Promise(resolve => {
    listener({ type: "warmup" }, {}, resolve);
  });
  await warm();
  await warm();
  assert.equal(requests.length, 0);
});

test("a missing whole-word IPA is filled locally without removing -ed or querying the base", async () => {
  const source = dictionary({ engulfed: { text: "v. 吞没，淹没" } });
  const result = await source.lookupCached("engulfed");
  assert.equal(result.us, "ɪnˈɡəɫft");
  assert.deepEqual(source.requests, ["engulfed"]);
  assert.equal(source.localLoads(), 1);
  await source.lookupCached("engulfed");
  assert.equal(source.localLoads(), 1);
});

test("standalone nouns and adjectives keep their own pronunciation", async () => {
  const source = dictionary({
    morning: "n. 早晨",
    building: { text: "n. 建筑物", us: "ˈbɪldɪŋ" },
    interesting: { text: "adj. 有趣的", us: "ˈɪntrəstɪŋ" },
    learned: { text: "adj. 博学的" },
    went: { text: "v. 去（go 的过去式）；n. 人名", us: "went" }
  });
  const morning = await source.lookupCached("morning");
  assert.equal(morning.us, "ˈmɔɹnɪŋ");
  for (const word of ["building", "interesting", "learned", "went"]) await source.lookupCached(word);
  const learned = await source.lookupCached("learned");
  assert.deepEqual(Array.from(learned.ipaVariants), ["ˈɫɝnd", "ˈɫɝnɪd"]);
  assert.equal(source.localLoads(), 2);
});

test("the bundled IPA wordlist contains full forms and standalone -ing words", () => {
  const e = fs.readFileSync(path.join(__dirname, "pronunciation", "en_US", "e.txt"), "utf8");
  const m = fs.readFileSync(path.join(__dirname, "pronunciation", "en_US", "m.txt"), "utf8");
  const b = fs.readFileSync(path.join(__dirname, "pronunciation", "en_US", "b.txt"), "utf8");
  assert.match(e, /^engulfed\t\/ɪnˈɡəɫft\/$/m);
  assert.match(m, /^morning\t\//m);
  assert.match(b, /^building\t\//m);
});

test("an exact hyphenated entry takes priority", async () => {
  const source = dictionary({ "risk-diversified": { text: "adj. 风险分散的", us: "rɪsk daɪˈvɜːrsɪfaɪd" }, risk: "n. 风险", diversified: "adj. 多样化的" });
  const result = await source.lookup("risk-diversified");
  assert.equal(result.lines[0], "adj. 风险分散的");
  assert.equal(result.note, undefined);
  assert.deepEqual(source.requests, ["risk-diversified"]);
});

test("an exact compound uses phonetics from the same dictionary response", async () => {
  const source = dictionary({ "well-run": { text: "adj. 经营得好的", simpleUs: "ˌwel ˈrʌn" } });
  const result = await source.lookup("well-run");
  assert.equal(result.us, "ˌwel ˈrʌn");
  assert.deepEqual(source.requests, ["well-run"]);
});

test("a compound without whole-word phonetics labels its component phonetics", async () => {
  const source = dictionary({ "well-run": "adj. 经营得好的", well: { text: "adv. 好", us: "wel" }, run: { text: "v. 跑", us: "rʌn" } });
  const result = await source.lookup("well-run");
  assert.equal(result.us, "");
  assert.deepEqual(JSON.parse(JSON.stringify(result.componentPhones)), [
    { word: "well", phone: "wel" }, { word: "run", phone: "rʌn" }
  ]);
  assert.deepEqual(source.requests, ["well-run", "well", "run"]);
});

test("missing component phonetics are not presented as a complete transcription", async () => {
  const source = dictionary({ "well-run": "adj. 经营得好的", well: { text: "adv. 好", us: "wel" }, run: "v. 跑" });
  const result = await source.lookup("well-run");
  assert.equal(result.lines[0], "adj. 经营得好的");
  assert.equal(result.componentPhones.length, 0);
});

test("a legacy compound migrates unchanged without enrichment or a network request", async () => {
  const records = { "word:v7:well-run": { at: Date.now(), data: { word: "well-run", headword: "well-run",
    us: "", uk: "", lines: ["adj. 经营得好的"], meanings: [{ pos: "adj", text: "经营得好的" }] } } };
  const requests = [];
  const context = vm.createContext({
    chrome: { runtime: { onMessage: { addListener() {} } }, storage: { local: {
      async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, records[key]])); },
      async set(items) { Object.assign(records, items); }
    } } },
    AbortController, setTimeout, clearTimeout,
    fetch: async url => {
      const word = new URL(url).searchParams.get("q");
      requests.push(word);
      return { ok: true, json: async () => ({ ec: { word: [{ headword: word,
        usphone: word === "well" ? "wel" : "rʌn", trs: [{ tr: [{ l: { i: ["n. Example"] } }] }] }] } }) };
    }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "service-worker.js"), "utf8"), context);
  const result = await vm.runInContext("lookup('well-run')", context);
  assert.equal(result.lines[0], "adj. 经营得好的");
  assert.deepEqual(requests, []);
  assert.equal(result.componentPhonesChecked, undefined);
  await vm.runInContext("flushLibraryWrites()", context);
  assert.deepEqual(records["library:v1:well-run"], records["word:v7:well-run"]);
});

test("unknown compounds show their parts without claiming a whole-word translation", async () => {
  const source = dictionary({ poacher: "n. 偷猎者", protected: "adj. 受保护的" });
  const result = await source.lookup("poacher-protected");
  assert.match(result.note, /不等于整词翻译/);
  assert.deepEqual(Array.from(result.lines), ["poacher：n. 偷猎者", "protected：adj. 受保护的"]);
});

test("compound fallback reuses an already known part without querying it again", async () => {
  const source = dictionary({ poacher: "n. 偷猎者", protected: "adj. 受保护的" });
  await source.lookupCached("poacher");
  const earlierRequests = source.requests.filter(word => word === "poacher").length;
  const result = await source.lookup("poacher-protected");
  assert.equal(result.lines[0], "poacher：n. 偷猎者");
  assert.equal(source.requests.filter(word => word === "poacher").length, earlierRequests);
});

test("unknown ordinary words remain errors", async () => {
  const source = dictionary({});
  await assert.rejects(source.lookup("notaword"), { name: "NoEntryError" });
});

test("a confirmed missing word is briefly cached, but a network error is retried", async () => {
  const missing = dictionary({});
  await assert.rejects(missing.lookupCached("notaword"), { name: "NoEntryError" });
  const missingRequests = missing.requests.length;
  await assert.rejects(missing.lookupCached("notaword"), { name: "NoEntryError" });
  assert.equal(missing.requests.length, missingRequests);

  const offline = dictionary({}, ["offline"]);
  await assert.rejects(offline.lookupCached("offline"), /Network unavailable/);
  const failedRequests = offline.requests.length;
  await assert.rejects(offline.lookupCached("offline"), /Network unavailable/);
  assert.ok(offline.requests.length > failedRequests);
});

test("an exhausted total deadline stops lookup before another request", async () => {
  const source = dictionary({ reserve: "v. 保留" });
  await assert.rejects(source.lookupWithDeadline("reserve", Date.now() - 1), { name: "LookupTimeoutError" });
  assert.deepEqual(source.requests, []);
});

test("a failed compound part is not mislabeled as absent from the dictionary", async () => {
  const source = dictionary({ poacher: "n. 偷猎者" }, ["protected"]);
  await assert.rejects(source.lookup("poacher-protected"), /Network unavailable/);
});

test("a punctuation dash is rejected rather than queried as a compound", () => {
  let listener;
  const context = vm.createContext({ chrome: { runtime: { onMessage: { addListener(fn) { listener = fn; } } } } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "service-worker.js"), "utf8"), context);
  let response;
  listener({ type: "lookup", word: "diprenorphine—a" }, {}, value => { response = value; });
  assert.equal(response.ok, false);
  assert.match(response.error, /无法识别/);
});

test("a missing possessive name explains the grammar instead of claiming a network fault", async () => {
  const source = dictionary({});
  const result = await source.lookup("jooste's", "Jooste's");
  assert.equal(result.headword, "Jooste's");
  assert.equal(result.unlistedPossessive, true);
  assert.match(result.note, /Jooste.*未被词典收录/);
  assert.match(result.lines[0], /Jooste 的/);
});

test("a known possessive uses the base word's definition", async () => {
  const source = dictionary({ cat: "n. 猫" });
  const result = await source.lookup("cat's", "cat's");
  assert.equal(result.lines[0], "n. 猫");
  assert.match(result.note, /所属/);
});

test("possessive fallback reuses an already known base word", async () => {
  const source = dictionary({ cat: "n. 猫" });
  await source.lookupCached("cat");
  const earlierRequests = source.requests.filter(word => word === "cat").length;
  const result = await source.lookup("cat's", "cat's");
  assert.equal(result.lines[0], "n. 猫");
  assert.equal(source.requests.filter(word => word === "cat").length, earlierRequests);
});

test("network failure is not mistaken for an unlisted name", async () => {
  const source = dictionary({}, ["jooste's"]);
  await assert.rejects(source.lookup("jooste's", "Jooste's"), /Network unavailable/);
});

test("parts of speech are separated without splitting the provider's semicolon text", () => {
  const source = dictionary({});
  const parsed = source.parse(["v. 预订；保留 n. 储备（量）；储藏（量）", "n. 储备（量）；储藏（量）"]);
  assert.deepEqual(parsed, [
    { pos: "v", text: "预订；保留" },
    { pos: "n", text: "储备（量）；储藏（量）" },
    { pos: "n", text: "储备（量）；储藏（量）" }
  ]);
});

test("the dictionary parser preserves duplicates and original part-of-speech labels", () => {
  const source = dictionary({});
  assert.deepEqual(source.parse(["n. 保留", "n. 保留", "n. 保留。", "v. 保留", "vt. 保留", "vi. 保留", "npl. 保留"]), [
    { pos: "n", text: "保留" },
    { pos: "n", text: "保留" },
    { pos: "n", text: "保留。" },
    { pos: "v", text: "保留" },
    { pos: "vt", text: "保留" },
    { pos: "vi", text: "保留" },
    { pos: "npl", text: "保留" }
  ]);
});

test("unknown formatting stays visible rather than being silently discarded", () => {
  const source = dictionary({});
  assert.deepEqual(source.parse(["【短语】a special phrase"]), [{ pos: "", text: "【短语】a special phrase" }]);
  assert.deepEqual(source.parse(["【用法说明】 n. 测试"]), [
    { pos: "", text: "【用法说明】" }, { pos: "n", text: "测试" }
  ]);
});

test("a complete answer and repeated clicks never wait for a stalled background save", async () => {
  let finishWrite;
  const write = new Promise(resolve => { finishWrite = resolve; });
  let reads = 0;
  let requests = 0;
  const context = vm.createContext({
    chrome: {
      runtime: { onMessage: { addListener() {} } },
      storage: { local: {
        async get() { reads++; return {}; },
        set() { return write; }
      } }
    },
    AbortController, setTimeout, clearTimeout,
    fetch: async () => {
      requests++;
      return { ok: true, json: async () => ({ ec: { word: [{ headword: "reserve", trs: [{ tr: [{ l: { i: ["v. 保留"] } }] }] }] } }) };
    }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "service-worker.js"), "utf8"), context);
  const lookup = vm.runInContext("lookup", context);
  let completed = false;
  const pending = lookup("reserve").then(result => { completed = true; return result; });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(completed, true, "complete definition must not wait for disk writes");
  const result = await pending;
  assert.equal(result.meanings[0].text, "保留");
  assert.equal(await lookup("reserve"), result);
  assert.equal(reads, 2);
  assert.equal(requests, 1);
  finishWrite();
  await vm.runInContext("flushLibraryWrites()", context);
});

test("a permanent library entry never expires and is returned byte-for-byte without a request", async () => {
  const original = { word: "reserve", headword: "reserve", us: "rɪˈzɜːrv", uk: "",
    lines: ["v. 预订；保留", "n. 储备（量）", "n. 储备（量）"],
    meanings: [{ pos: "v", text: "预订；保留" }, { pos: "n", text: "储备（量）" }, { pos: "n", text: "储备（量）" }],
    providerFieldKept: { untouched: true } };
  const records = { "library:v1:reserve": { at: 1, data: original } };
  let requests = 0;
  const context = vm.createContext({
    chrome: {
      runtime: { onMessage: { addListener() {} } },
      storage: { local: {
        async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, records[key]])); },
        async set(items) { Object.assign(records, items); }
      } }
    },
    AbortController, setTimeout, clearTimeout,
    fetch: async () => { requests++; throw new Error("A permanent entry must not use the network"); }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "service-worker.js"), "utf8"), context);
  const result = JSON.parse(await vm.runInContext("lookup('reserve').then(value => JSON.stringify(value))", context));
  assert.deepEqual(result, original);
  assert.equal(requests, 0);
});

test("a successful lookup is written to the stable personal library", async () => {
  const records = {};
  const context = vm.createContext({
    chrome: {
      runtime: { onMessage: { addListener() {} } },
      storage: { local: {
        async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, records[key]])); },
        async set(items) { Object.assign(records, items); }
      } }
    },
    AbortController, setTimeout, clearTimeout,
    fetch: async () => ({ ok: true, json: async () => ({ ec: { word: [{ headword: "reserve", usphone: "rɪˈzɜːrv",
      trs: [{ tr: [{ l: { i: ["v. 预订；保留", "n. 储备（量）"] } }] }] }] } }) })
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "service-worker.js"), "utf8"), context);
  const result = await vm.runInContext("lookup('reserve')", context);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(JSON.parse(JSON.stringify(records["library:v1:reserve"].data)), JSON.parse(JSON.stringify(result)));
  assert.equal(records["word:v7:reserve"], undefined);
});

test("an extension update migrates every successful legacy cache entry without changing it", async () => {
  const oldReserve = { at: 123, data: { word: "reserve", lines: ["v. 预订；保留", "n. 储备"] } };
  const existing = { at: 456, data: { word: "kept", lines: ["adj. 已保存的永久版本"] } };
  const records = {
    "word:v7:reserve": oldReserve,
    "word:v7:notaword": { at: 789, noEntry: true },
    "word:v6:obsolete": { at: 100, data: { lines: ["旧格式"] } },
    "library:v1:kept": existing,
    "word:v7:kept": { at: 999, data: { lines: ["不得覆盖"] } }
  };
  const context = vm.createContext({
    chrome: {
      runtime: { onMessage: { addListener() {} } },
      storage: { local: {
        async get() { return { ...records }; },
        async set(items) { Object.assign(records, items); }
      } }
    },
    AbortController, setTimeout, clearTimeout
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "service-worker.js"), "utf8"), context);
  assert.equal(await vm.runInContext("migrateLegacyCache()", context), 1);
  assert.deepEqual(JSON.parse(JSON.stringify(records["library:v1:reserve"])), oldReserve);
  assert.equal(records["library:v1:notaword"], undefined);
  assert.equal(records["library:v1:obsolete"], undefined);
  assert.deepEqual(records["library:v1:kept"], existing);
});

test("storage failure does not prevent a complete online definition from appearing", async () => {
  const context = vm.createContext({
    chrome: {
      runtime: { onMessage: { addListener() {} } },
      storage: { local: {
        async get() { throw new Error("storage read failed"); },
        async set() { throw new Error("storage write failed"); }
      } }
    },
    AbortController, setTimeout, clearTimeout,
    fetch: async () => ({ ok: true, json: async () => ({ ec: { word: [{ headword: "reserve", trs: [{ tr: [{ l: { i: ["v. 保留"] } }] }] }] } }) })
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "service-worker.js"), "utf8"), context);
  const result = await vm.runInContext("lookup('reserve')", context);
  assert.equal(result.meanings[0].text, "保留");
  await vm.runInContext("flushLibraryWrites()", context);
  assert.equal(vm.runInContext("pendingWrites.size", context), 1);
  assert.match(vm.runInContext("saveError", context), /尚未保存/);
});

test("a slow request is aborted at the remaining lookup deadline", async () => {
  const context = vm.createContext({
    chrome: { runtime: { onMessage: { addListener() {} } } },
    AbortController, setTimeout, clearTimeout,
    fetch: (_url, { signal }) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    })
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "service-worker.js"), "utf8"), context);
  await assert.rejects(vm.runInContext("getJson('https://dict.youdao.com/jsonapi?q=test', Date.now() + 15)", context),
    { name: "LookupTimeoutError" });
});

test("a stalled cache read respects the same total deadline", async () => {
  let requests = 0;
  const context = vm.createContext({
    chrome: {
      runtime: { onMessage: { addListener() {} } },
      storage: { local: { get: () => new Promise(() => {}) } }
    },
    AbortController, setTimeout, clearTimeout,
    fetch: async () => { requests++; throw new Error("Network should not start"); }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "service-worker.js"), "utf8"), context);
  await assert.rejects(vm.runInContext("lookup('reserve', 'reserve', Date.now() + 15)", context),
    { name: "LookupTimeoutError" });
  assert.equal(requests, 0);
});

test("a full cache removes only disposable lookup entries and retries the write", async () => {
  const now = Date.now();
  const records = {
    "word:v7:expired": { at: now - 31 * 24 * 60 * 60 * 1000, data: { lines: ["old"] } },
    "word:v7:missing": { at: 1, noEntry: true },
    "word:v7:recent": { at: now - 1000, data: { lines: ["recent"] } },
    "word:v6:old": { at: now - 1000, data: { lines: ["outdated schema"] } },
    "library:v1:kept": { at: 1, data: { lines: ["永久保留"] } },
    "other:settings": { enabled: true }
  };
  let writes = 0;
  const context = vm.createContext({
    chrome: {
      runtime: { onMessage: { addListener() {} } },
      storage: { local: {
        async get(key) { return key === null ? { ...records } : { [key]: records[key] }; },
        async getBytesInUse() { return 9 * 1024 * 1024; },
        async remove(keys) { for (const key of keys) delete records[key]; },
        async set(items) {
          writes++;
          if (writes === 1) throw new Error("Quota exceeded");
          Object.assign(records, items);
        }
      } }
    },
    AbortController, setTimeout, clearTimeout
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "service-worker.js"), "utf8"), context);
  vm.runInContext("storeCache('word:v7:new', { at: Date.now(), data: { lines: ['new'] } })", context);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(writes, 2);
  assert.ok(records["word:v7:expired"], "unmigrated success must survive cleanup");
  assert.ok(records["word:v6:old"]);
  assert.equal(records["word:v7:missing"], undefined);
  assert.deepEqual(records["other:settings"], { enabled: true });
  assert.deepEqual(records["library:v1:kept"].data.lines, ["永久保留"]);
  assert.ok(records["word:v7:new"]);
});

test("a confirmed miss survives a worker restart briefly, then expires", async () => {
  const records = {};
  let requests = 0;
  const makeWorker = () => {
    const context = vm.createContext({
      chrome: {
        runtime: { onMessage: { addListener() {} } },
        storage: { local: {
          async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, records[key]])); },
          async set(items) { Object.assign(records, items); }
        } }
      },
      AbortController, setTimeout, clearTimeout,
      fetch: async url => {
        requests++;
        return { ok: true, json: async () => url.includes("/jsonapi")
          ? { ec: null } : { data: { entries: [] } } };
      }
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, "service-worker.js"), "utf8"), context);
    return () => vm.runInContext("lookup('notaword')", context);
  };
  await assert.rejects(makeWorker()(), { name: "NoEntryError" });
  const firstRequests = requests;
  assert.ok(records["word:v7:notaword"].noEntry);
  await assert.rejects(makeWorker()(), { name: "NoEntryError" });
  assert.equal(requests, firstRequests);
  records["word:v7:notaword"].at -= 16 * 60 * 1000;
  await assert.rejects(makeWorker()(), { name: "NoEntryError" });
  assert.ok(requests > firstRequests);
});
