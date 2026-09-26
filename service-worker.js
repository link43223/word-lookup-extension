"use strict";

const CACHE_PREFIX = "word:v6:";
const CACHE_AGE = 30 * 24 * 60 * 60 * 1000;
const inflight = new Map();

class NoEntryError extends Error {
  constructor(message) { super(message); this.name = "NoEntryError"; }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "lookup") return;
  const word = String(message.word || "").toLowerCase().replace(/[‐‑‒–—]/g, "-");
  const surface = String(message.surface || message.word || "").replace(/’/g, "'");
  if (!/^[a-z]+(?:['-][a-z]+)*$/.test(word) || word.length > 48) {
    sendResponse({ ok: false, error: "无法识别这个单词" });
    return;
  }
  lookup(word, surface).then(
    data => sendResponse({ ok: true, data }),
    error => sendResponse({ ok: false, error: error instanceof NoEntryError
      ? "词典暂未收录这个词" : "网络请求失败，请稍后重试" })
  );
  return true;
});

async function lookup(word, surface = word) {
  const key = CACHE_PREFIX + word + (word.endsWith("'s") ? ":" + surface : "");
  const saved = (await chrome.storage.local.get(key))[key];
  if (saved && Date.now() - saved.at < CACHE_AGE && saved.data) return saved.data;
  if (inflight.has(key)) return inflight.get(key);
  const task = lookupOnline(word, surface).then(async data => {
    data.meanings = parseMeanings(data.lines || []);
    await chrome.storage.local.set({ [key]: { at: Date.now(), data } });
    return data;
  }).finally(() => inflight.delete(key));
  inflight.set(key, task);
  return task;
}

async function getJson(url, timeout = 4500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error("Lookup failed");
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function cleanLines(lines) {
  return lines.filter(line => typeof line === "string" && line.trim())
    .map(line => line.trim());
}

const POS_NAMES = "n|npl|v|vt|vi|adj|adv|prep|conj|pron|art|aux|modal|det|num|int|abbr|phr|pref|suf";

function parseMeanings(lines) {
  const meanings = [];
  for (const raw of lines) {
    if (typeof raw !== "string") continue;
    const line = raw.replace(/\s+/g, " ").trim();
    if (!line) continue;
    const markers = Array.from(line.matchAll(new RegExp(`(^|[\\s;；])(${POS_NAMES})\\.\\s*`, "gi")));
    if (!markers.length) {
      addMeaning("", line);
      continue;
    }
    for (let index = 0; index < markers.length; index++) {
      const marker = markers[index];
      const start = marker.index + marker[0].length;
      const end = index + 1 < markers.length ? markers[index + 1].index : line.length;
      addMeaning(marker[2].toLowerCase(), line.slice(start, end).replace(/^[\s;；]+|[\s;；]+$/g, ""));
    }
  }
  return meanings;

  function addMeaning(pos, text) {
    const gloss = text.trim();
    if (!gloss) return;
    meanings.push({ pos, text: gloss });
  }
}

function normaliseHeadword(value, fallback) {
  if (Array.isArray(value)) value = value[0];
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[a-z]+(?:['-][a-z]+)*$/.test(text) ? text : fallback;
}

async function lookupOnline(word, surface = word) {
  try {
    return await lookupExact(word);
  } catch (error) {
    if (!(error instanceof NoEntryError)) throw error;
    if (word.endsWith("'s") && word.length > 3) {
      const base = word.slice(0, -2);
      const displayBase = surface.slice(0, -2);
      try {
        const result = await lookupExact(base);
        return {
          ...result,
          word,
          headword: surface,
          note: "“'s”表示所属，相当于“……的”；以下是原词 “" + displayBase + "” 的释义。"
        };
      } catch (baseError) {
        if (!(baseError instanceof NoEntryError)) throw baseError;
        return {
          word,
          headword: surface,
          us: "",
          uk: "",
          note: "“" + displayBase + "” 未被词典收录，可能是人名或其他专有名称。",
          lines: ["'s 表示所属；这里可理解为“" + displayBase + " 的……”"]
        };
      }
    }
    if (!word.includes("-")) throw error;
    const parts = word.split("-");
    const results = await Promise.allSettled(parts.map(part => lookupExact(part)));
    if (!results.some(result => result.status === "fulfilled")) throw error;
    return {
      word,
      headword: word,
      us: "",
      uk: "",
      note: "整词未收录，以下是组成词的释义，不等于整词翻译：",
      lines: results.map((result, index) => parts[index] + "：" +
        (result.status === "fulfilled" ? result.value.lines.join("；") : "暂未查到释义"))
    };
  }
}

async function lookupExact(word) {
  let primaryError = null;
  try {
    const json = await getJson("https://dict.youdao.com/jsonapi?q=" + encodeURIComponent(word));
    const entry = json.ec && json.ec.word && json.ec.word[0];
    const lines = cleanLines(((entry && entry.trs) || []).flatMap(item =>
      (item.tr || []).flatMap(translation => Array.isArray(translation.l?.i) ? translation.l.i : [])
    ));
    const headword = entry && normaliseHeadword(entry["return-phrase"] || entry.headword || entry.word, word);
    if (lines.length && (!word.includes("-") || headword === word)) {
      return {
        word,
        headword,
        us: entry.usphone || "",
        uk: entry.ukphone || "",
        lines
      };
    }
  } catch (error) { primaryError = error; }

  const json = await getJson("https://dict.youdao.com/suggest?num=1&ver=3.0&doctype=json&cache=false&le=en&q=" + encodeURIComponent(word));
  const entries = (json.data && json.data.entries) || [];
  const entry = entries.find(item => String(item.entry || "").toLowerCase() === word);
  if (!entry || !entry.explain) {
    if (primaryError) throw primaryError;
    throw new NoEntryError("No exact dictionary entry");
  }
  return { word, headword: word, us: "", uk: "", lines: [String(entry.explain)] };
}
