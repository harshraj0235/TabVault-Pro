/**
 * TabVault Pro — Smart Tab Suspender
 * Uses chrome.tabs.discard() to free memory from inactive tabs.
 */

import { STORES, get, put } from '../storage/db.js';
import { getAllTabs } from './tab-monitor.js';

const DEFAULT_SETTINGS = {
  enabled: true,
  inactiveMinutes: 30,
  neverSuspendPinned: true,
  neverSuspendAudible: true,
  neverSuspendActive: true,
  neverSuspendGrouped: false,
  whitelistDomains: [],
  aggressiveMode: false
};

async function getSuspenderSettings() {
  const stored = await get(STORES.SETTINGS, 'suspender');
  return stored?.value || { ...DEFAULT_SETTINGS };
}

async function updateSuspenderSettings(updates) {
  const current = await getSuspenderSettings();
  const merged = { ...current, ...updates };
  await put(STORES.SETTINGS, { key: 'suspender', value: merged });
  return merged;
}

function shouldSkipSuspension(tab, settings) {
  if (settings.neverSuspendActive && tab.active) return true;
  if (settings.neverSuspendPinned && tab.pinned) return true;
  if (settings.neverSuspendAudible && tab.audible) return true;
  if (settings.neverSuspendGrouped && tab.groupId > 0) return true;
  if (tab.url?.startsWith('chrome://') || tab.url?.startsWith('chrome-extension://')) return true;
  if (settings.whitelistDomains.length > 0) {
    const domain = tab.domain || '';
    if (settings.whitelistDomains.some(d => domain.includes(d))) return true;
  }
  return false;
}

async function runSuspensionCheck() {
  const settings = await getSuspenderSettings();
  if (!settings.enabled) return { suspended: 0, skipped: 0 };
  const tabs = getAllTabs();
  const now = Date.now();
  const thresholdMs = settings.inactiveMinutes * 60 * 1000;
  let suspended = 0, skipped = 0;
  for (const tab of tabs) {
    if (tab.discarded) { skipped++; continue; }
    if (shouldSkipSuspension(tab, settings)) { skipped++; continue; }
    const inactiveTime = now - (tab.lastAccessed || now);
    if (inactiveTime >= thresholdMs) {
      try { await chrome.tabs.discard(tab.id); suspended++; } catch (e) { skipped++; }
    }
  }
  return { suspended, skipped };
}

async function suspendTab(tabId) {
  try { await chrome.tabs.discard(tabId); return true; } catch (e) { return false; }
}

async function suspendAllInactive() {
  const settings = await getSuspenderSettings();
  const tabs = getAllTabs();
  let suspended = 0;
  for (const tab of tabs) {
    if (tab.discarded || tab.active) continue;
    if (shouldSkipSuspension(tab, settings)) continue;
    try { await chrome.tabs.discard(tab.id); suspended++; } catch (e) { /* ignore */ }
  }
  return suspended;
}

function getMemorySavings() {
  const tabs = getAllTabs();
  const discardedCount = tabs.filter(t => t.discarded).length;
  const estimatedSavingsMB = discardedCount * 50;
  return { suspendedTabs: discardedCount, activeTabs: tabs.length - discardedCount, estimatedSavingsMB, estimatedSavingsGB: (estimatedSavingsMB / 1024).toFixed(1) };
}

function setupSuspensionAlarm() {
  chrome.alarms.create('tabvault-suspension-check', { periodInMinutes: 5 });
}

export { getSuspenderSettings, updateSuspenderSettings, runSuspensionCheck, suspendTab, suspendAllInactive, getMemorySavings, setupSuspensionAlarm };
