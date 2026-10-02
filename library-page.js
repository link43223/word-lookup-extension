"use strict";

const BACKUP_DB_NAME = "word-lookup-library-backup";
const BACKUP_STORE_NAME = "handles";
const BACKUP_HANDLE_KEY = "automatic-backup";
const MAX_IMPORT_BYTES = 32 * 1024 * 1024;
const fileTypes = [{ description: "点词即查个人词库", accept: { "application/json": [".json"] } }];
const statusEl = document.querySelector("#backup-status");
const messageEl = document.querySelector("#message");
const chooseButton = document.querySelector("#choose-backup");
const backupButton = document.querySelector("#backup-now");
const authorizeButton = document.querySelector("#reauthorize");
const restoreInput = document.querySelector("#restore-file");
let connectedHandle = null;
let busy = false;
let refreshId = 0;

function openBackupDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(BACKUP_DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(BACKUP_STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("无法打开备份设置"));
  });
}

async function accessHandle(handle) {
  const db = await openBackupDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(BACKUP_STORE_NAME, handle ? "readwrite" : "readonly");
      const store = transaction.objectStore(BACKUP_STORE_NAME);
      const request = handle ? store.put(handle, BACKUP_HANDLE_KEY) : store.get(BACKUP_HANDLE_KEY);
      // A successful request is not yet a committed transaction.
      transaction.oncomplete = () => resolve(handle || request.result || null);
      transaction.onabort = () => reject(transaction.error || new Error("备份设置未能保存"));
      transaction.onerror = () => reject(transaction.error || new Error("备份设置读取失败"));
    });
  } finally { db.close(); }
}

async function refreshStatus() {
  const current = ++refreshId;
  try {
    const [result, handle] = await Promise.all([callWorker({ type: "library-status" }), accessHandle()]);
    const permission = handle ? await handle.queryPermission({ mode: "readwrite" }) : "";
    if (current !== refreshId) return;
    connectedHandle = handle;
    if (handle && permission !== "granted") result.backup = { ...result.backup, state: "permission" };
    document.querySelector("#library-count").textContent = String(result.count);
    statusEl.textContent = describeBackup(result);
    const savedAt = result.backup.lastSuccessAt || result.backup.updatedAt;
    document.querySelector("#file-details").textContent = [
      handle?.name || result.backup.filename,
      savedAt ? "上次成功：" + new Date(savedAt).toLocaleString() : ""
    ].filter(Boolean).join(" · ");
    backupButton.disabled = busy || !handle || permission !== "granted";
    authorizeButton.hidden = !handle || permission === "granted";
    authorizeButton.disabled = busy || !handle;
  } catch (error) {
    if (current === refreshId) statusEl.textContent = error.message;
  }
}

async function perform(action) {
  if (busy) return;
  busy = true;
  messageEl.className = "";
  messageEl.textContent = "正在处理…";
  document.querySelectorAll("button").forEach(button => { button.disabled = true; });
  try { messageEl.textContent = await action(); }
  catch (error) {
    messageEl.textContent = error?.name === "AbortError" ? "已取消，现有词库不受影响。" : error.message || "操作失败，请重试";
    if (error?.name !== "AbortError") messageEl.className = "error";
  } finally {
    busy = false;
    document.querySelectorAll("button").forEach(button => { button.disabled = false; });
    await refreshStatus();
  }
}

async function readBackup(file) {
  if (file.size > MAX_IMPORT_BYTES) throw new Error("备份超过 32 MB，未导入；请保留原文件，勿覆盖");
  try { return JSON.parse(await file.text()); }
  catch (_) { throw new Error("文件不是有效的 JSON，未修改现有词库或备份"); }
}

function requireSaved(result) {
  if (result.state !== "saved") throw new Error(result.error || "尚未写入电脑文件，请重新授权后重试");
}

chooseButton.addEventListener("click", () => { void perform(async () => {
  if (typeof window.showSaveFilePicker !== "function") throw new Error("此浏览器不支持自动文件备份，请使用“下载独立副本”");
  const handle = await window.showSaveFilePicker({ suggestedName: "点词即查-个人词库.json", types: fileTypes });
  const file = await handle.getFile();
  // Never overwrite a pre-existing backup (or an unrelated JSON file) before validating it.
  if (file.size) await callWorker({ type: "library-import", backup: await readBackup(file) });
  await accessHandle(handle);
  const result = await callWorker({ type: "backup-now" });
  requireSaved(result);
  return "自动备份已开启，已写入 " + result.count + " 个词条。";
}); });

authorizeButton.addEventListener("click", () => { void perform(async () => {
  if (!connectedHandle) throw new Error("请先选择备份文件");
  // Request directly in the user's click, before unrelated asynchronous work.
  if (await connectedHandle.requestPermission({ mode: "readwrite" }) !== "granted") {
    throw new Error("未获得写入权限；本地词库仍然保留，但自动备份尚未恢复");
  }
  const result = await callWorker({ type: "backup-now" });
  requireSaved(result);
  return "已重新授权并完成备份。";
}); });

backupButton.addEventListener("click", () => { void perform(async () => {
  const result = await callWorker({ type: "backup-now" });
  requireSaved(result);
  return "已写入 " + result.count + " 个词条到电脑备份文件。";
}); });

document.querySelector("#restore-backup").addEventListener("click", () => restoreInput.click());
restoreInput.addEventListener("change", () => {
  const file = restoreInput.files?.[0];
  restoreInput.value = "";
  if (file) void perform(async () => {
    const result = await callWorker({ type: "library-import", backup: await readBackup(file) });
    return "已恢复 " + result.added + " 个词条，保留本地已有 " + result.skipped + " 个。若未连接自动备份，请在上方选择备份文件。";
  });
});

document.querySelector("#export-backup").addEventListener("click", () => { void perform(async () => {
  const { backup } = await callWorker({ type: "library-export" });
  const url = URL.createObjectURL(new Blob([JSON.stringify(backup)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "点词即查-个人词库-" + new Date().toISOString().slice(0, 10) + ".json";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return "已发起下载，请在浏览器下载记录中确认文件保存成功。此副本不会自动更新。";
}); });

chrome.storage.onChanged.addListener((_changes, area) => { if (area === "local") void refreshStatus(); });
window.addEventListener("focus", () => { void refreshStatus(); });
void refreshStatus();
