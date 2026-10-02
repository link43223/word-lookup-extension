"use strict";

// This namespace is data, not an application version. Keep it stable across releases.
const CACHE_PREFIX = "word:v7:";
const LIBRARY_PREFIX = "library:v1:";
const BACKUP_STATUS_KEY = "library-meta:backup";
const LIBRARY_META_KEY = "library-meta:state";
const LIBRARY_RESET_KEY = "library-meta:restored";
const BACKUP_DB_NAME = "word-lookup-library-backup";
const BACKUP_STORE_NAME = "handles";
const BACKUP_HANDLE_KEY = "automatic-backup";
const BACKUP_ALARM = "library-backup";
const SAVE_ALARM = "library-save-retry";
const SAVE_STATUS_KEY = "library-meta:save";
const PENDING_PREFIX = "library-pending:v1:";
const MISSING_AGE = 15 * 60 * 1000;
const LOOKUP_BUDGET = 8000;
const PRUNE_AT_BYTES = 8 * 1024 * 1024;
const HOT_CACHE_LIMIT = 128;
const PART_PHONE_BUDGET = 1200;
const LOCAL_IPA_VERSION = 1;
const inflight = new Map();
const hotCache = new Map();
const localIpaTasks = new Map();
let cacheWrites = 0;
let cleanupTask = null;
let backupTask = null;
let backupAgain = false;
let backupForce = false;
let backupTimer = null;
let mutationTail = Promise.resolve();
const pendingWrites = new Map();
let saveTask = null;
let saveTimer = null;
let saveError = "";
let restoreEpoch = 0;

class NoEntryError extends Error {
  constructor(message) { super(message); this.name = "NoEntryError"; }
}
class LookupTimeoutError extends Error {
  constructor() { super("Lookup timed out"); this.name = "LookupTimeoutError"; }
}
class LibrarySaveError extends Error {
  constructor() { super("本地词库保存失败，请检查磁盘空间后重试"); this.name = "LibrarySaveError"; }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return;
  if (message.type === "warmup") {
    // Wake the local worker only. Hovering must not send a network request.
    sendResponse({ ok: true });
    return;
  }
  const management = ["library-status", "library-export", "library-import", "backup-now"];
  if (management.includes(message.type)) {
    const root = chrome.runtime.getURL("");
    if (!sender?.url?.startsWith(root) || sender.tab?.url?.startsWith("http")) {
      sendResponse({ ok: false, error: "请从词库管理页面操作" });
      return;
    }
    const action = async () => {
      if (message.type === "library-status") return getLibraryStatus();
      if (message.type === "library-export") return { backup: await exportLibrary() };
      if (message.type === "library-import") return importLibrary(message.backup);
      return requestBackup(true);
    };
    action().then(value => sendResponse({ ok: true, ...value }),
      error => sendResponse({ ok: false, error: error.message || "操作失败，请重试" }));
    return true;
  }
  if (message.type !== "lookup") return;
  const word = String(message.word || "").toLowerCase().replace(/[‐‑]/g, "-").replace(/’/g, "'");
  const surface = String(message.surface || message.word || "").replace(/’/g, "'");
  if (!/^[a-z]+(?:['-][a-z]+)*$/.test(word) || word.length > 48) {
    sendResponse({ ok: false, error: "无法识别这个单词" });
    return;
  }
  lookup(word, surface).then(data => sendResponse({ ok: true, data }),
    error => sendResponse({ ok: false, error: error instanceof NoEntryError
      ? "词典暂未收录这个词" : error instanceof LibrarySaveError ? error.message
        : error instanceof LookupTimeoutError ? "查询超时，请稍后重试" : "网络请求失败，请稍后重试",
      code: error instanceof NoEntryError ? "NO_ENTRY" : "" }));
  return true;
});

// Serialise every library mutation so imports, migration and delayed lookups cannot overwrite one another.
function withLibraryWrite(action) {
  const task = mutationTail.then(action);
  mutationTail = task.catch(() => {});
  return task;
}

async function initialiseLibrary() {
  await migrateLegacyCache();
  scheduleAutomaticBackup();
}
chrome.runtime.onInstalled?.addListener(() => { void initialiseLibrary(); });
chrome.runtime.onStartup?.addListener(() => { void initialiseLibrary(); });
chrome.alarms?.onAlarm.addListener(alarm => {
  if (alarm.name === BACKUP_ALARM) void requestBackup().catch(() => {});
  if (alarm.name === SAVE_ALARM) void resumePendingWrites().then(flushLibraryWrites).catch(() => {});
});

async function migrateLegacyCache() {
  try {
    return await withLibraryWrite(async () => {
      const all = await chrome.storage.local.get(null);
      const additions = {};
      for (const [key, value] of Object.entries(all)) {
        if (!key.startsWith(CACHE_PREFIX) || !value?.data) continue;
        const libraryKey = LIBRARY_PREFIX + key.slice(CACHE_PREFIX.length);
        if (!all[libraryKey]) additions[libraryKey] = value;
      }
      const count = Object.keys(additions).length;
      if (count) {
        additions[LIBRARY_META_KEY] = nextLibraryState(all[LIBRARY_META_KEY]);
        await chrome.storage.local.set(additions);
        scheduleAutomaticBackup();
      }
      return count;
    });
  } catch (_) { return 0; }
}

function nextLibraryState(previous) {
  return { revision: (Number(previous?.revision) || 0) + 1, dirty: true };
}

function readHotCache(key) {
  const saved = hotCache.get(key);
  if (!saved) return null;
  if (saved.noEntry && Date.now() - saved.at >= MISSING_AGE) { hotCache.delete(key); return null; }
  hotCache.delete(key);
  hotCache.set(key, saved);
  return saved;
}

function rememberHotCache(key, saved) {
  hotCache.delete(key);
  hotCache.set(key, saved);
  if (hotCache.size > HOT_CACHE_LIMIT) hotCache.delete(hotCache.keys().next().value);
}

function withinDeadline(promise, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(new LookupTimeoutError());
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new LookupTimeoutError()), remaining); })
  ]).finally(() => clearTimeout(timer));
}

function lookup(word, surface = word, deadline = Date.now() + LOOKUP_BUDGET) {
  const suffix = word + (word.endsWith("'s") ? ":" + surface : "");
  const libraryKey = LIBRARY_PREFIX + suffix;
  const key = CACHE_PREFIX + suffix;
  const permanent = readHotCache(libraryKey) || pendingWrites.get(libraryKey);
  if (permanent?.data) return Promise.resolve(permanent.data);
  if (inflight.has(key)) return withinDeadline(inflight.get(key), deadline);
  const task = (async () => {
    const startedEpoch = restoreEpoch;
    let stored;
    try { stored = await withinDeadline(chrome.storage.local.get([libraryKey, key]), deadline); }
    catch (error) { if (error instanceof LookupTimeoutError) throw error; stored = {}; }
    if (stored[libraryKey]?.data) {
      rememberHotCache(libraryKey, stored[libraryKey]);
      return stored[libraryKey].data;
    }
    const waiting = pendingWrites.get(libraryKey);
    if (waiting?.data) return waiting.data;
    const saved = stored[key] || readHotCache(key);
    if (saved?.data) {
      // Preserve legacy successful data exactly; enrichment is only for new queries.
      queueLibraryWrite(libraryKey, saved);
      return saved.data;
    }
    if (saved?.noEntry && Date.now() - saved.at < MISSING_AGE) throw new NoEntryError("No exact dictionary entry");
    let data;
    try {
      data = await lookupOnline(word, surface, deadline);
      data = await attachLocalIpa(word, data, deadline);
    } catch (error) {
      // A restore may have supplied this word while the network was running.
      const restored = restoreEpoch !== startedEpoch
        ? (await chrome.storage.local.get(libraryKey))[libraryKey] : null;
      if (restored?.data) return restored.data;
      if (error instanceof NoEntryError) {
        const missing = { at: Date.now(), noEntry: true };
        rememberHotCache(key, missing);
        storeCache(key, missing);
      }
      throw error;
    }
    data.meanings = parseMeanings(data.lines || []);
    if (restoreEpoch !== startedEpoch) {
      const restored = (await chrome.storage.local.get(libraryKey))[libraryKey];
      if (restored?.data) { rememberHotCache(libraryKey, restored); return restored.data; }
    }
    queueLibraryWrite(libraryKey, { at: Date.now(), data });
    return data;
  })().finally(() => { if (inflight.get(key) === task) inflight.delete(key); });
  inflight.set(key, task);
  return task;
}

function queueLibraryWrite(key, entry) {
  rememberHotCache(key, entry);
  if (!pendingWrites.has(key)) pendingWrites.set(key, entry);
  // Yield before starting disk I/O: the complete response is sent first.
  if (!saveTimer) saveTimer = setTimeout(() => {
    saveTimer = null;
    void flushLibraryWrites().catch(() => {});
  }, 0);
}

async function resumePendingWrites() {
  if (!chrome.storage.session) return;
  const journal = await chrome.storage.session.get(null);
  const entries = Object.entries(journal).filter(([key, value]) => key.startsWith(PENDING_PREFIX) && value?.data);
  if (!entries.length) return;
  let saved = {};
  try {
    saved = await chrome.storage.local.get(entries.map(([key]) => LIBRARY_PREFIX + key.slice(PENDING_PREFIX.length)));
  } catch (_) {}
  for (const [key, value] of entries) {
    const libraryKey = LIBRARY_PREFIX + key.slice(PENDING_PREFIX.length);
    if (saved[libraryKey]?.data) {
      try { await chrome.storage.session.remove(key); } catch (_) {}
      continue;
    }
    if (!pendingWrites.has(libraryKey)) queueLibraryWrite(libraryKey, value);
  }
  if (!pendingWrites.size) {
    try { await chrome.storage.local.set({ [SAVE_STATUS_KEY]: { state: "saved", count: 0, error: "" } }); } catch (_) {}
  }
}

function flushLibraryWrites() {
  if (saveTask) return saveTask;
  if (!pendingWrites.size) return Promise.resolve();
  saveTask = (async () => {
    if (chrome.alarms) {
      try { await chrome.alarms.create(SAVE_ALARM, { delayInMinutes: 1, periodInMinutes: 1 }); } catch (_) {}
    }
    let failed = false;
    for (const [key, entry] of Array.from(pendingWrites)) {
      const journalKey = PENDING_PREFIX + key.slice(LIBRARY_PREFIX.length);
      // Session storage survives worker suspension, but is not advertised as permanent storage.
      try { await chrome.storage.session?.set({ [journalKey]: entry }); } catch (_) {}
      try {
        const saved = await storeLibrary(key, entry);
        if (hotCache.get(key) === entry) rememberHotCache(key, saved);
        if (pendingWrites.get(key) === entry) pendingWrites.delete(key);
        try { await chrome.storage.session?.remove(journalKey); } catch (_) {}
      } catch (_) { failed = true; }
    }
    saveError = failed ? "部分词条尚未保存到磁盘，后台将重试，请检查磁盘空间" : "";
    try {
      await chrome.storage.local.set({ [SAVE_STATUS_KEY]: {
        state: failed ? "error" : pendingWrites.size ? "pending" : "saved",
        count: pendingWrites.size, error: saveError
      } });
    } catch (_) {}
    try {
      await chrome.action?.setBadgeText({ text: failed ? "!" : "" });
      if (failed) await chrome.action?.setBadgeBackgroundColor({ color: "#b42318" });
    } catch (_) {}
    if (!pendingWrites.size && chrome.alarms) {
      try { await chrome.alarms.clear(SAVE_ALARM); } catch (_) {}
    }
    return !failed;
  })().finally(() => {
    saveTask = null;
    // New words arriving during a flush get their own pass, without spinning on failures.
    if (pendingWrites.size && !saveError && !saveTimer) {
      saveTimer = setTimeout(() => { saveTimer = null; void flushLibraryWrites().catch(() => {}); }, 0);
    }
  });
  return saveTask;
}

void resumePendingWrites().catch(() => {});

async function storeLibrary(key, entry) {
  try {
    return await withLibraryWrite(async () => {
      const stored = await chrome.storage.local.get([key, LIBRARY_META_KEY]);
      // Existing entries, including restored ones, always win over a late online answer.
      if (stored[key]?.data) return stored[key];
      await chrome.storage.local.set({ [key]: entry, [LIBRARY_META_KEY]: nextLibraryState(stored[LIBRARY_META_KEY]) });
      scheduleAutomaticBackup();
      return entry;
    });
  } catch (_) { throw new LibrarySaveError(); }
}

function scheduleAutomaticBackup() {
  if (typeof indexedDB === "undefined") return;
  // The alarm survives worker suspension. The short timer coalesces nearby writes.
  if (chrome.alarms) void chrome.alarms.create(BACKUP_ALARM, { delayInMinutes: 1, periodInMinutes: 5 }).catch(() => {});
  clearTimeout(backupTimer);
  backupTimer = setTimeout(() => { backupTimer = null; void requestBackup().catch(() => {}); }, 1200);
}

function openBackupDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(BACKUP_DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(BACKUP_STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("无法打开备份设置"));
  });
}

async function getBackupHandle() {
  if (typeof indexedDB === "undefined") return null;
  const db = await openBackupDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(BACKUP_STORE_NAME).objectStore(BACKUP_STORE_NAME).get(BACKUP_HANDLE_KEY);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error("无法读取备份设置"));
    });
  } finally { db.close(); }
}

async function getLibraryStatus() {
  const keys = chrome.storage.local.getKeys ? await chrome.storage.local.getKeys()
    : Object.keys(await chrome.storage.local.get(null));
  const meta = await chrome.storage.local.get([BACKUP_STATUS_KEY, LIBRARY_META_KEY, SAVE_STATUS_KEY]);
  return { count: keys.filter(key => key.startsWith(LIBRARY_PREFIX)).length,
    save: pendingWrites.size ? { state: saveError ? "error" : "pending", count: pendingWrites.size, error: saveError }
      : meta[SAVE_STATUS_KEY] || { state: "saved", count: 0 },
    backup: meta[BACKUP_STATUS_KEY] || { state: "unconfigured" },
    dirty: Boolean(meta[LIBRARY_META_KEY]?.dirty) };
}

function backupFromRecords(all) {
  return { format: "word-lookup-personal-library", version: 1, exportedAt: new Date().toISOString(),
    entries: Object.entries(all).filter(([key, value]) => key.startsWith(LIBRARY_PREFIX) && value?.data)
      .sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => ({ key, value })) };
}

async function exportLibrary() {
  await flushLibraryWrites();
  if (pendingWrites.size) throw new Error("有词条尚未保存，请稍后重试导出");
  await mutationTail;
  return backupFromRecords(await chrome.storage.local.get(null));
}

function validateBackup(backup) {
  if (!backup || backup.format !== "word-lookup-personal-library" || backup.version !== 1 ||
      !Array.isArray(backup.entries) || backup.entries.length > 100000) throw new Error("不是有效的点词即查备份文件");
  const seen = new Set();
  for (const item of backup.entries) {
    const suffix = typeof item?.key === "string" && item.key.startsWith(LIBRARY_PREFIX)
      ? item.key.slice(LIBRARY_PREFIX.length) : "";
    const word = suffix.split(":")[0];
    const data = item?.value?.data;
    const meaningsValid = data?.meanings === undefined || (Array.isArray(data.meanings) &&
      data.meanings.every(sense => sense && typeof sense.pos === "string" && typeof sense.text === "string"));
    if (!/^[a-z]+(?:['-][a-z]+)*$/.test(word) || word.length > 48 ||
        (suffix !== word && !(word.endsWith("'s") && suffix.startsWith(word + ":") &&
          /^[A-Za-z]+(?:['-][A-Za-z]+)*$/.test(suffix.slice(word.length + 1)) &&
          suffix.slice(word.length + 1).toLowerCase() === word)) ||
        !Number.isFinite(item.value?.at) || !data || typeof data !== "object" ||
        !Array.isArray(data.lines) || !data.lines.length || !data.lines.every(line => typeof line === "string") ||
        !meaningsValid || seen.has(item.key) || JSON.stringify(item).length > 256 * 1024) {
      throw new Error("备份中存在损坏或重复的词条，未导入任何内容");
    }
    seen.add(item.key);
  }
  return backup.entries;
}

async function importLibrary(backup) {
  const entries = validateBackup(backup);
  return withLibraryWrite(async () => {
    const all = await chrome.storage.local.get(null);
    const additions = {};
    for (const { key, value } of entries) if (!all[key]?.data) additions[key] = value;
    const added = Object.keys(additions).length;
    const state = nextLibraryState(all[LIBRARY_META_KEY]);
    // Even a no-op restore invalidates page copies and old network callbacks.
    additions[LIBRARY_RESET_KEY] = state.revision;
    additions[LIBRARY_META_KEY] = state;
    await chrome.storage.local.set(additions);
    for (const key of pendingWrites.keys()) {
      const saved = additions[key]?.data ? additions[key] : all[key];
      if (saved?.data) pendingWrites.set(key, saved);
    }
    restoreEpoch++;
    hotCache.clear();
    inflight.clear();
    scheduleAutomaticBackup();
    return { added, skipped: entries.length - added };
  });
}

// Automatic and manual backups share this queue; two file writers never race.
function requestBackup(force = false) {
  backupForce ||= force;
  if (backupTask) { backupAgain = true; return backupTask; }
  backupTask = (async () => {
    let result;
    do {
      backupAgain = false;
      const forceThisWrite = backupForce;
      backupForce = false;
      if (forceThisWrite) {
        await withLibraryWrite(async () => {
          const current = (await chrome.storage.local.get(LIBRARY_META_KEY))[LIBRARY_META_KEY];
          await chrome.storage.local.set({ [LIBRARY_META_KEY]: { revision: current?.revision || 0, dirty: true } });
          scheduleAutomaticBackup();
        });
      }
      result = await writeAutomaticBackup(forceThisWrite);
    } while (backupAgain);
    return result;
  })().finally(() => { backupTask = null; });
  return backupTask;
}

async function writeAutomaticBackup(force = false) {
  let previous = {};
  let handle;
  try {
    await flushLibraryWrites();
    if (pendingWrites.size) throw new Error("有词条尚未保存，待后台保存成功后再备份");
    previous = (await chrome.storage.local.get(BACKUP_STATUS_KEY))[BACKUP_STATUS_KEY] || {};
    handle = await getBackupHandle();
    if (!handle) {
      if (chrome.alarms) await chrome.alarms.clear(BACKUP_ALARM);
      await chrome.storage.local.set({ [BACKUP_STATUS_KEY]: { state: "unconfigured" } });
      return { state: "unconfigured" };
    }
    if (await handle.queryPermission({ mode: "readwrite" }) !== "granted") {
      const status = { ...previous, state: "permission", filename: handle.name,
        error: "需要重新授权文件访问，请打开词库与备份页面" };
      await chrome.storage.local.set({ [BACKUP_STATUS_KEY]: status });
      if (chrome.alarms) await chrome.alarms.clear(BACKUP_ALARM);
      return status;
    }
    const all = await withLibraryWrite(() => chrome.storage.local.get(null));
    if (!force && !all[LIBRARY_META_KEY]?.dirty && previous.state === "saved") {
      await withLibraryWrite(async () => {
        const current = (await chrome.storage.local.get(LIBRARY_META_KEY))[LIBRARY_META_KEY];
        if (current?.dirty) backupAgain = true;
        else if (chrome.alarms) await chrome.alarms.clear(BACKUP_ALARM);
      });
      return previous;
    }
    const snapshot = backupFromRecords(all);
    const revision = all[LIBRARY_META_KEY]?.revision || 0;
    const writable = await handle.createWritable();
    try {
      await writable.write(JSON.stringify(snapshot));
      await writable.close();
    } catch (error) {
      try { await writable.abort(); } catch (_) {}
      throw error;
    }
    return await withLibraryWrite(async () => {
      const current = (await chrome.storage.local.get(LIBRARY_META_KEY))[LIBRARY_META_KEY];
      const status = { state: "saved", filename: handle.name, count: snapshot.entries.length,
        lastSuccessAt: Date.now(), revision };
      const items = { [BACKUP_STATUS_KEY]: status };
      if ((current?.revision || 0) === revision) {
        items[LIBRARY_META_KEY] = { revision, dirty: false };
        if (chrome.alarms) await chrome.alarms.clear(BACKUP_ALARM);
      } else backupAgain = true;
      await chrome.storage.local.set(items);
      return status;
    });
  } catch (error) {
    const status = { ...previous, state: "error", filename: handle?.name || previous.filename || "",
      error: error.message || "备份写入失败，请确认文件和磁盘可用" };
    try { await chrome.storage.local.set({ [BACKUP_STATUS_KEY]: status }); } catch (_) {}
    if (chrome.alarms) {
      try { await chrome.alarms.create(BACKUP_ALARM, { delayInMinutes: 1, periodInMinutes: 5 }); } catch (_) {}
    }
    throw new Error(status.error);
  }
}

function storeCache(key, entry) {
  try {
    void chrome.storage.local.set({ [key]: entry }).then(
      () => { if (++cacheWrites % 64 === 0) void scheduleCacheCleanup(false).catch(() => {}); },
      async () => {
        try {
          await scheduleCacheCleanup(true);
          await chrome.storage.local.set({ [key]: entry });
        } catch (_) { /* Cache maintenance must not affect a ready answer. */ }
      }
    );
  } catch (_) { /* Best-effort cache. */ }
}

function scheduleCacheCleanup(force) {
  if (!cleanupTask) cleanupTask = pruneCache(force).finally(() => { cleanupTask = null; });
  return cleanupTask;
}

async function pruneCache(force) {
  const bytes = await chrome.storage.local.getBytesInUse(null);
  if (!force && bytes < PRUNE_AT_BYTES) return;
  const saved = await chrome.storage.local.get(null);
  const now = Date.now();
  // Never evict successful definitions, even legacy ones not yet migrated.
  const remove = Object.entries(saved).filter(([key, item]) => {
    if (!key.startsWith(CACHE_PREFIX)) return false;
    if (item?.data) return Boolean(saved[LIBRARY_PREFIX + key.slice(CACHE_PREFIX.length)]?.data);
    return !item || !Number.isFinite(item.at) || now - item.at >= MISSING_AGE;
  }).map(([key]) => key);
  if (remove.length) await chrome.storage.local.remove(remove);
}

async function getJson(url, deadline = Date.now() + LOOKUP_BUDGET) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new LookupTimeoutError();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(4500, remaining));
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error("Lookup failed");
    return await response.json();
  } catch (error) {
    if (controller.signal.aborted) throw new LookupTimeoutError();
    throw error;
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
    const prefix = line.slice(0, markers[0].index).trim();
    if (prefix) addMeaning("", prefix);
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

function phoneOf(data) {
  const phone = data && (data.us || data.uk || data.phone);
  return typeof phone === "string" ? phone.replace(/^\/+|\/+$/g, "").trim() : "";
}

function needsLocalIpa(word, data) {
  return Boolean(data && /^[a-z]+$/.test(word) && !phoneOf(data) &&
    data.localIpaVersion !== LOCAL_IPA_VERSION);
}

function loadLocalIpa(word) {
  const initial = word[0];
  if (!localIpaTasks.has(initial)) {
    const task = fetch(chrome.runtime.getURL("pronunciation/en_US/" + initial + ".txt"))
      .then(response => {
        if (!response.ok) throw new Error("Local pronunciation dictionary unavailable");
        return response.text();
      })
      .then(text => {
        const words = new Map();
        for (const line of text.split(/\r?\n/)) {
          const tab = line.indexOf("\t");
          if (tab > 0) words.set(line.slice(0, tab).toLowerCase(), line.slice(tab + 1));
        }
        return words;
      })
      .catch(error => { localIpaTasks.delete(initial); throw error; });
    localIpaTasks.set(initial, task);
  }
  return localIpaTasks.get(initial);
}

async function attachLocalIpa(word, data, deadline) {
  if (!needsLocalIpa(word, data)) return data;
  try {
    const words = await withinDeadline(loadLocalIpa(word), deadline);
    const raw = words.get(word) || "";
    const variants = raw.split(",").map(part => part.trim().replace(/^\/+|\/+$/g, "")).filter(Boolean);
    return {
      ...data,
      us: variants.length === 1 ? variants[0] : data.us,
      ipaVariants: variants.length > 1 ? variants : [],
      localIpaVersion: LOCAL_IPA_VERSION
    };
  } catch (_) {
    // Missing or slow optional local data must never hide a complete definition.
    return data;
  }
}

function needsPartPhones(word, data) {
  return Boolean(data && word.includes("-") && !phoneOf(data) && !data.componentPhonesChecked);
}

async function attachPartPhones(word, data, deadline) {
  if (!needsPartPhones(word, data)) return data;
  const parts = word.split("-");
  const partDeadline = Math.min(deadline, Date.now() + PART_PHONE_BUDGET);
  const results = await Promise.allSettled(parts.map(part => lookup(part, part, partDeadline)));
  const componentPhones = results.map((result, index) => ({
    word: parts[index], phone: result.status === "fulfilled" ? phoneOf(result.value) : ""
  }));
  return { ...data, componentPhones: componentPhones.every(part => part.phone) ? componentPhones : [], componentPhonesChecked: true };
}

function responsePhones(json, entry, word) {
  const simple = json.simple;
  const simpleMatches = simple && String(simple.query || "").trim().toLowerCase() === word;
  const simpleWord = simpleMatches && Array.isArray(simple.word) ? simple.word[0] : null;
  return {
    us: entry.usphone || simpleWord?.usphone || "",
    uk: entry.ukphone || simpleWord?.ukphone || "",
    phone: entry.phone || simpleWord?.phone || ""
  };
}

async function lookupOnline(word, surface = word, deadline = Date.now() + LOOKUP_BUDGET) {
  try {
    return await attachPartPhones(word, await lookupExact(word, deadline), deadline);
  } catch (error) {
    if (!(error instanceof NoEntryError)) throw error;
    if (word.endsWith("'s") && word.length > 3) {
      const base = word.slice(0, -2);
      const displayBase = surface.slice(0, -2);
      try {
        const result = await lookup(base, base, deadline);
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
          unlistedPossessive: true,
          note: "“" + displayBase + "” 未被词典收录，可能是人名或其他专有名称。",
          lines: ["'s 表示所属；这里可理解为“" + displayBase + " 的……”"]
        };
      }
    }
    if (!word.includes("-")) throw error;
    const parts = word.split("-");
    const results = await Promise.allSettled(parts.map(part => lookup(part, part, deadline)));
    const failedRequest = results.find(result => result.status === "rejected" && !(result.reason instanceof NoEntryError));
    if (failedRequest) throw failedRequest.reason;
    if (!results.some(result => result.status === "fulfilled")) throw error;
    const componentPhones = results.map((result, index) => ({
      word: parts[index], phone: result.status === "fulfilled" ? phoneOf(result.value) : ""
    }));
    return {
      word,
      headword: word,
      us: "",
      uk: "",
      componentPhones: componentPhones.every(part => part.phone) ? componentPhones : [],
      componentPhonesChecked: true,
      note: "整词未收录，以下是组成词的释义，不等于整词翻译：",
      lines: results.map((result, index) => parts[index] + "：" +
        (result.status === "fulfilled" ? result.value.lines.join("；") : "暂未查到释义"))
    };
  }
}

async function lookupExact(word, deadline = Date.now() + LOOKUP_BUDGET) {
  let primaryError = null;
  try {
    const json = await getJson("https://dict.youdao.com/jsonapi?q=" + encodeURIComponent(word), deadline);
    const entry = json.ec && json.ec.word && json.ec.word[0];
    const lines = cleanLines(((entry && entry.trs) || []).flatMap(item =>
      (item.tr || []).flatMap(translation => Array.isArray(translation.l?.i) ? translation.l.i : [])
    ));
    const headword = entry && normaliseHeadword(entry["return-phrase"] || entry.headword || entry.word, word);
    if (lines.length && (!word.includes("-") || headword === word)) {
      return {
        word,
        headword,
        ...responsePhones(json, entry, word),
        lines
      };
    }
  } catch (error) { primaryError = error; }

  const json = await getJson("https://dict.youdao.com/suggest?num=1&ver=3.0&doctype=json&cache=false&le=en&q=" + encodeURIComponent(word), deadline);
  const entries = (json.data && json.data.entries) || [];
  const entry = entries.find(item => String(item.entry || "").toLowerCase() === word);
  if (!entry || !entry.explain) {
    if (primaryError) throw primaryError;
    throw new NoEntryError("No exact dictionary entry");
  }
  return { word, headword: word, us: "", uk: "", lines: [String(entry.explain)] };
}
