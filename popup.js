"use strict";

document.querySelector("#manage-library").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

async function refreshStatus() {
  try {
    const result = await callWorker({ type: "library-status" });
    document.querySelector("#library-count").textContent = String(result.count);
    document.querySelector("#backup-status").textContent = describeBackup(result);
  } catch (error) {
    document.querySelector("#backup-status").textContent = error.message;
  }
}
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === "local") void refreshStatus();
});
void refreshStatus();
