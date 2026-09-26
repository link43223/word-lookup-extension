"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function dictionary(entries, failingQueries = []) {
  const requests = [];
  const context = vm.createContext({
    chrome: { runtime: { onMessage: { addListener() {} } } },
    AbortController,
    setTimeout,
    clearTimeout,
    fetch: async url => {
      const query = new URL(url).searchParams.get("q");
      requests.push(query);
      if (failingQueries.includes(query)) throw new Error("Network unavailable");
      const definition = entries[query];
      const body = url.includes("/jsonapi")
        ? { ec: definition ? { word: [{ headword: query, trs: [{ tr: [{ l: { i: [definition] } }] }] }] } : null }
        : { data: { entries: [] } };
      return { ok: true, json: async () => body };
    }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "service-worker.js"), "utf8"), context);
  return { lookup: (word, surface = word) => vm.runInContext(
    `lookupOnline(${JSON.stringify(word)}, ${JSON.stringify(surface)})`, context),
    parse: lines => JSON.parse(vm.runInContext(`JSON.stringify(parseMeanings(${JSON.stringify(lines)}))`, context)), requests };
}

test("an exact hyphenated entry takes priority", async () => {
  const source = dictionary({ "risk-diversified": "adj. 风险分散的", risk: "n. 风险", diversified: "adj. 多样化的" });
  const result = await source.lookup("risk-diversified");
  assert.equal(result.lines[0], "adj. 风险分散的");
  assert.equal(result.note, undefined);
  assert.deepEqual(source.requests, ["risk-diversified"]);
});

test("unknown compounds show their parts without claiming a whole-word translation", async () => {
  const source = dictionary({ poacher: "n. 偷猎者", protected: "adj. 受保护的" });
  const result = await source.lookup("poacher-protected");
  assert.match(result.note, /不等于整词翻译/);
  assert.deepEqual(Array.from(result.lines), ["poacher：n. 偷猎者", "protected：adj. 受保护的"]);
});

test("unknown ordinary words remain errors", async () => {
  const source = dictionary({});
  await assert.rejects(source.lookup("notaword"), { name: "NoEntryError" });
});

test("a missing possessive name explains the grammar instead of claiming a network fault", async () => {
  const source = dictionary({});
  const result = await source.lookup("jooste's", "Jooste's");
  assert.equal(result.headword, "Jooste's");
  assert.match(result.note, /Jooste.*未被词典收录/);
  assert.match(result.lines[0], /Jooste 的/);
});

test("a known possessive uses the base word's definition", async () => {
  const source = dictionary({ cat: "n. 猫" });
  const result = await source.lookup("cat's", "cat's");
  assert.equal(result.lines[0], "n. 猫");
  assert.match(result.note, /所属/);
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
});
