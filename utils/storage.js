export const STORAGE_KEYS = Object.freeze({
  SETTINGS: "settings",
  LOGS: "logs",
  RUNTIME: "runtimeState"
});

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  intervalMinSeconds: 30,
  intervalMaxSeconds: 60,
  pageWaitMinSeconds: 5,
  pageWaitMaxSeconds: 10,
  maxConcurrentTabs: 3,
  keepAliveUrlMode: "hostname",
  blacklist: [],
  whitelistEnabled: false,
  whitelist: [],
  // 为空表示保活全部站点；非空时只保活勾选的域名。
  siteSelection: []
});

const MAX_LOGS = 100;

export async function getSettings() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
  return sanitizeSettings(result[STORAGE_KEYS.SETTINGS]);
}

export async function saveSettings(input) {
  const settings = sanitizeSettings(input);
  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: settings });
  return settings;
}

export function sanitizeSettings(input = {}) {
  return {
    enabled: input.enabled !== false,
    // 兼容旧字段：intervalSeconds / intervalMinutes 自动换算为区间；min > max 时自动对调。
    intervalMinSeconds: normalizeIntervalRange(input).min,
    intervalMaxSeconds: normalizeIntervalRange(input).max,
    // 兼容旧字段：pageWaitSeconds 自动变为上下限相同的范围；min > max 时自动对调。
    pageWaitMinSeconds: normalizeWaitRange(input).min,
    pageWaitMaxSeconds: normalizeWaitRange(input).max,
    maxConcurrentTabs: clampInteger(input.maxConcurrentTabs, 1, 10, DEFAULT_SETTINGS.maxConcurrentTabs),
    keepAliveUrlMode: input.keepAliveUrlMode === "randomOpenUrl" ? "randomOpenUrl" : DEFAULT_SETTINGS.keepAliveUrlMode,
    blacklist: normalizeDomainList(input.blacklist),
    whitelistEnabled: input.whitelistEnabled === true,
    whitelist: normalizeDomainList(input.whitelist),
    siteSelection: normalizeDomainList(input.siteSelection)
  };
}

export function normalizeDomainList(value) {
  const values = Array.isArray(value) ? value : String(value || "").split(/[\n,]+/);
  return [...new Set(values.map(normalizeDomainRule).filter(Boolean))];
}

export function domainListToText(value) {
  return normalizeDomainList(value).join("\n");
}

export function matchesDomain(hostname, rules) {
  const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
  return normalizeDomainList(rules).some((rule) => host === rule || host.endsWith("." + rule));
}

export async function getLogs() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.LOGS);
  return Array.isArray(result[STORAGE_KEYS.LOGS]) ? result[STORAGE_KEYS.LOGS] : [];
}

export async function appendLog(log) {
  const logs = await getLogs();
  logs.unshift(log);
  await chrome.storage.local.set({ [STORAGE_KEYS.LOGS]: logs.slice(0, MAX_LOGS) });
}

export async function clearLogs() {
  await chrome.storage.local.remove(STORAGE_KEYS.LOGS);
}

export function formatDateTime(timestamp = Date.now()) {
  const date = new Date(timestamp);
  const pad = (number) => String(number).padStart(2, "0");
  return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) + " " + pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds());
}

function normalizeDomainRule(value) {
  let rule = String(value || "").trim().toLowerCase();
  if (!rule) return "";

  try {
    if (rule.includes("://")) rule = new URL(rule).hostname;
  } catch {
    return "";
  }

  rule = rule.split("/")[0].split(":")[0].replace(/^\*\./, "").replace(/\.$/, "");
  if (rule === "localhost") return rule;
  return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(rule) ? rule : "";
}

function normalizeWaitRange(input) {
  const legacy = Number.isInteger(input.pageWaitSeconds) ? input.pageWaitSeconds : undefined;
  const min = clampInteger(input.pageWaitMinSeconds ?? legacy, 0, 300, DEFAULT_SETTINGS.pageWaitMinSeconds);
  const max = clampInteger(input.pageWaitMaxSeconds ?? legacy, 0, 300, DEFAULT_SETTINGS.pageWaitMaxSeconds);
  return { min: Math.min(min, max), max: Math.max(min, max) };
}

function normalizeIntervalRange(input) {
  // 优先读新版区间字段，其次旧版 intervalSeconds，最后旧版 intervalMinutes（分钟）。
  const legacy = Number.isInteger(input.intervalSeconds)
    ? input.intervalSeconds
    : (Number.isInteger(input.intervalMinutes) ? input.intervalMinutes * 60 : undefined);
  const min = clampInteger(input.intervalMinSeconds ?? legacy, 30, 60, DEFAULT_SETTINGS.intervalMinSeconds);
  const max = clampInteger(input.intervalMaxSeconds ?? legacy, 30, 60, DEFAULT_SETTINGS.intervalMaxSeconds);
  return { min: Math.min(min, max), max: Math.max(min, max) };
}

function clampInteger(value, minimum, maximum, fallback) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}
