import { domainListToText, matchesDomain, saveSettings } from "../utils/storage.js";

const ui = {
  status: document.querySelector("#statusBadge"),
  notice: document.querySelector("#notice"),
  siteCount: document.querySelector("#siteCount"),
  interval: document.querySelector("#interval"),
  activeCount: document.querySelector("#activeCount"),
  sites: document.querySelector("#siteList"),
  run: document.querySelector("#runNow"),
  form: document.querySelector("#settingsForm"),
  autoSaveStatus: document.querySelector("#autoSaveStatus"),
  intervalMinInput: document.querySelector("#intervalMinSeconds"),
  intervalMaxInput: document.querySelector("#intervalMaxSeconds"),
  waitMinInput: document.querySelector("#pageWaitMinSeconds"),
  waitMaxInput: document.querySelector("#pageWaitMaxSeconds"),
  concurrencyInput: document.querySelector("#maxConcurrentTabs"),
  keepAliveUrlMode: document.querySelector("#keepAliveUrlMode"),
  blacklist: document.querySelector("#blacklist"),
  whitelistEnabled: document.querySelector("#whitelistEnabled"),
  whitelist: document.querySelector("#whitelist"),
  logCount: document.querySelector("#logCount"),
  totalLogs: document.querySelector("#totalLogs"),
  successRate: document.querySelector("#successRate"),
  allLogs: document.querySelector("#allLogs"),
  clearLogs: document.querySelector("#clearLogs")
};

let dashboard = null;
let runAction = "RUN_NOW";
let noticeTimer = null;
let autoSaveTimer = null;
let saveInFlight = false;
let saveQueued = false;
let settingsInitialized = false;

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => switchView(tab.dataset.view));
});
ui.run.addEventListener("click", handleRunAction);
ui.clearLogs.addEventListener("click", async () => {
  if (!window.confirm("确定清空全部运行日志？此操作不可恢复。")) return;
  ui.clearLogs.disabled = true;
  try {
    await refresh("CLEAR_LOGS");
    showNotice("日志已清空");
  } catch (error) {
    showNotice("清空失败：" + error.message, true);
  } finally {
    ui.clearLogs.disabled = false;
  }
});
ui.form.addEventListener("submit", (event) => event.preventDefault());
ui.form.querySelectorAll("[data-autosave]").forEach((field) => {
  if (field instanceof HTMLInputElement && field.type === "number") {
    // 失焦时把超出范围的数值自动钳制到 min/max，避免停留在非法值。
    field.addEventListener("blur", () => {
      if (field.value === "" || field.validity.valid) return;
      const minimum = Number(field.min);
      const maximum = Number(field.max);
      const number = Number(field.value);
      if (!Number.isFinite(number)) return;
      field.value = String(Math.min(maximum, Math.max(minimum, Math.round(number))));
      field.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }
  field.addEventListener("input", () => scheduleAutoSave(field instanceof HTMLTextAreaElement ? 400 : 250));
  field.addEventListener("change", () => scheduleAutoSave(0));
});
ui.whitelistEnabled.addEventListener("change", updateWhitelistState);
// 勾选/取消站点后立即保存选择；未勾选任何站点时不执行保活。
ui.sites.addEventListener("change", async (event) => {
  const checkbox = event.target.closest('input[type="checkbox"][data-domain]');
  if (!checkbox || !dashboard) return;
  const domain = checkbox.dataset.domain;
  const current = dashboard.settings.siteSelection;
  const selection = checkbox.checked
    ? [...new Set([...current, domain])]
    : current.filter((item) => item !== domain);
  try {
    await persistSettings({ ...dashboard.settings, siteSelection: selection });
  } catch (error) {
    showNotice("保存选择失败：" + error.message, true);
    await refresh();
  }
});

void refresh();

async function refresh(type = "GET_DASHBOARD") {
  try {
    const data = await chrome.runtime.sendMessage({ type });
    if (!data?.ok) throw new Error(data?.error || "无法读取后台状态");
    dashboard = data;
    render(data);
  } catch (error) {
    ui.status.className = "status error";
    ui.status.textContent = "读取失败";
    showNotice(error.message, true);
  }
}

async function handleRunAction() {
  const action = runAction;
  ui.run.disabled = true;
  ui.run.textContent = action === "STOP_ALL" ? "正在停止…" : "正在启动…";
  await refresh(action);
  showNotice(action === "STOP_ALL" ? "已关闭：本轮任务和定时均已停止" : "已开启：本轮正在执行，之后按设定间隔自动运行");
}

function scheduleAutoSave(delay) {
  window.clearTimeout(autoSaveTimer);
  setAutoSaveStatus("pending", "等待自动保存…");
  autoSaveTimer = window.setTimeout(queueAutoSave, delay);
}

async function queueAutoSave() {
  window.clearTimeout(autoSaveTimer);
  if (!dashboard) return;
  if (!ui.form.checkValidity()) {
    setAutoSaveStatus("error", "数值超出允许范围，尚未保存");
    return;
  }
  if (saveInFlight) {
    saveQueued = true;
    return;
  }

  saveInFlight = true;
  setAutoSaveStatus("saving", "正在自动保存…");
  try {
    await persistSettings({
      enabled: dashboard.settings.enabled,
      intervalMinSeconds: Number(ui.intervalMinInput.value),
      intervalMaxSeconds: Number(ui.intervalMaxInput.value),
      pageWaitMinSeconds: Number(ui.waitMinInput.value),
      pageWaitMaxSeconds: Number(ui.waitMaxInput.value),
      maxConcurrentTabs: Number(ui.concurrencyInput.value),
      keepAliveUrlMode: ui.keepAliveUrlMode.value,
      blacklist: ui.blacklist.value,
      whitelistEnabled: ui.whitelistEnabled.checked,
      whitelist: ui.whitelist.value
    });
    const now = new Date();
    setAutoSaveStatus("saved", "已自动保存 " + String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0") + ":" + String(now.getSeconds()).padStart(2, "0"));
  } catch (error) {
    setAutoSaveStatus("error", "自动保存失败：" + error.message);
  } finally {
    saveInFlight = false;
    if (saveQueued) {
      saveQueued = false;
      scheduleAutoSave(0);
    }
  }
}

async function persistSettings(settings) {
  await saveSettings(settings);
  const response = await chrome.runtime.sendMessage({ type: "SETTINGS_CHANGED" });
  if (!response?.ok) throw new Error(response?.error || "后台未确认设置");
  await refresh();
}

function render({ settings, runtime, sites, logs }) {
  ui.status.className = "status " + (settings.enabled ? "running" : "paused");
  ui.status.innerHTML = "<i></i>" + (settings.enabled ? (runtime.isRunning ? "执行中" : "运行中") : "已停用");
  ui.siteCount.textContent = sites.length;
  const min = Math.min(settings.intervalMinSeconds, settings.intervalMaxSeconds);
  const max = Math.max(settings.intervalMinSeconds, settings.intervalMaxSeconds);
  ui.interval.textContent = max >= 60
    ? (min % 60 === 0 && max % 60 === 0 ? min / 60 + "–" + max / 60 + "m" : (min / 60).toFixed(1) + "–" + (max / 60).toFixed(1) + "m")
    : min + "–" + max + "s";
  ui.activeCount.textContent = runtime.activeCount;
  // 底部按钮即总开关：关闭时显示"开启保活"，开启时显示"关闭保活"。
  ui.run.disabled = false;
  runAction = settings.enabled ? "STOP_ALL" : "RUN_NOW";
  ui.run.classList.toggle("stop", settings.enabled);
  ui.run.textContent = settings.enabled
    ? (runtime.isRunning ? "关闭保活 · " + runtime.activeCount + " 个运行中" : "关闭保活")
    : "开启保活";
  ui.sites.innerHTML = sites.length
    ? sites.map((site) => {
      const selected = matchesDomain(site.domain, settings.siteSelection);
      return '<li><label class="site-row"><input type="checkbox" data-domain="' + escapeHtml(site.domain) + '"' + (selected ? " checked" : "") + '><span class="site-dot"></span><div><strong>' + escapeHtml(site.domain) + '</strong><small>' + escapeHtml(site.url) + "</small></div></label></li>";
    }).join("")
    : '<li class="empty">没有符合规则的网页</li>';

  // 只在首次加载时填充表单，避免后台刷新覆盖用户正在输入但尚未防抖保存的内容。
  if (!settingsInitialized) {
    ui.intervalMinInput.value = settings.intervalMinSeconds;
    ui.intervalMaxInput.value = settings.intervalMaxSeconds;
    ui.waitMinInput.value = settings.pageWaitMinSeconds;
    ui.waitMaxInput.value = settings.pageWaitMaxSeconds;
    ui.concurrencyInput.value = settings.maxConcurrentTabs;
    ui.keepAliveUrlMode.value = settings.keepAliveUrlMode;
    ui.blacklist.value = domainListToText(settings.blacklist);
    ui.whitelistEnabled.checked = settings.whitelistEnabled;
    ui.whitelist.value = domainListToText(settings.whitelist);
    settingsInitialized = true;
    updateWhitelistState();
  }
  renderLogs(logs);
}

function renderLogs(logs) {
  ui.logCount.textContent = logs.length;
  ui.totalLogs.textContent = logs.length;
  const successes = logs.filter((log) => log.result === "success").length;
  ui.successRate.textContent = logs.length ? Math.round(successes / logs.length * 100) + "%" : "—";
  ui.allLogs.innerHTML = logs.length
    ? logs.map((log) => '<article class="log-card"><span class="result ' + log.result + '">' + (log.result === "success" ? "SUCCESS" : "FAILED") + '</span><div><strong>' + escapeHtml(log.domain) + "</strong><time>" + escapeHtml(log.time) + " · " + formatDuration(log.duration) + "</time>" + (log.error ? "<small>" + escapeHtml(log.error) + "</small>" : "") + "</div></article>").join("")
    : '<p class="empty">完成首次任务后将在这里显示</p>';
}

function switchView(view) {
  document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.view === view));
  document.querySelectorAll(".view").forEach((panel) => panel.classList.toggle("active", panel.dataset.viewPanel === view));
}

function updateWhitelistState() {
  ui.whitelist.disabled = !ui.whitelistEnabled.checked;
  document.querySelector(".whitelist-field").classList.toggle("disabled", !ui.whitelistEnabled.checked);
}

function setAutoSaveStatus(state, message) {
  ui.autoSaveStatus.className = "autosave-status " + state;
  ui.autoSaveStatus.querySelector("span").textContent = message;
}

function showNotice(message, isError = false) {
  window.clearTimeout(noticeTimer);
  ui.notice.textContent = message;
  ui.notice.className = "notice visible " + (isError ? "error" : "success");
  noticeTimer = window.setTimeout(() => { ui.notice.className = "notice"; }, 3000);
}

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds)) return "—";
  return milliseconds < 1000 ? milliseconds + "ms" : (milliseconds / 1000).toFixed(1) + "s";
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}
