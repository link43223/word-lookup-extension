"use strict";

function callWorker(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, response => {
      if (chrome.runtime.lastError) { reject(new Error("后台连接中断，请重新打开此页面")); return; }
      if (!response?.ok) { reject(new Error(response?.error || "操作未完成，请重试")); return; }
      resolve(response);
    });
  });
}

function describeBackup({ backup = {}, dirty = false, save = {} }) {
  if (save.state === "error") return save.error || "部分词条尚未保存，后台正在重试";
  if (save.state === "pending") return "释义已可用，正在后台保存 " + save.count + " 个词条";
  if (backup.state === "permission" || backup.needsPermission) return "备份已暂停：需要重新授权文件";
  if (backup.state === "error") return "备份失败：" + (backup.error || "请检查文件和磁盘");
  if (backup.state === "saved" || backup.updatedAt) {
    return dirty ? "新增词条已存本地，等待更新电脑备份" : "已备份 " + (backup.count || 0) + " 个词条到电脑";
  }
  return "尚未设置电脑备份，卸载前请先备份";
}
