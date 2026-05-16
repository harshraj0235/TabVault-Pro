/**
 * TabVault Pro — Tab Monitor
 * 
 * Real-time tab tracking across all windows.
 * Maintains an in-memory cache synced with IndexedDB.
 * Detects duplicates and manages tab groups.
 */

import { STORES, put, putBatch, get, getAll, getByIndex, remove, extractDomain, generateId } from '../storage/db.js';

// In-memory cache — refreshed from IndexedDB on SW wake
let tabCache = new Map();
let initialized = false;

/**
 * Initialize tab monitor — load state from IndexedDB + reconcile with Chrome
 */
async function initTabMonitor() {
  if (initialized) return;

  try {
    // Load cached tabs from IndexedDB
    const storedTabs = await getAll(STORES.TABS);
    tabCache.clear();
    storedTabs.forEach(tab => tabCache.set(tab.id, tab));

    // Reconcile with actual Chrome tabs
    await reconcileTabs();
    initialized = true;
    console.log(`[TabVault Monitor] Initialized with ${tabCache.size} tabs`);
  } catch (error) {
    console.error('[TabVault Monitor] Init failed:', error);
    // Fallback: just read from Chrome directly
    await syncFromChrome();
    initialized = true;
  }
}

/**
 * Reconcile stored state with actual Chrome tabs
 * Called on every service worker startup
 */
async function reconcileTabs() {
  const chromeTabs = await chrome.tabs.query({});
  const chromeTabIds = new Set(chromeTabs.map(t => t.id));
  const storedTabIds = new Set(tabCache.keys());

  // Remove tabs that no longer exist in Chrome
  const removedIds = [];
  for (const id of storedTabIds) {
    if (!chromeTabIds.has(id)) {
      tabCache.delete(id);
      removedIds.push(id);
    }
  }

  // Add/update tabs from Chrome
  const upsertTabs = [];
  for (const chromeTab of chromeTabs) {
    const tabData = chromeTabToRecord(chromeTab);
    const existing = tabCache.get(chromeTab.id);
    
    if (!existing || existing.url !== tabData.url || existing.title !== tabData.title) {
      tabCache.set(chromeTab.id, tabData);
      upsertTabs.push(tabData);
    }
  }

  // Batch persist changes
  if (upsertTabs.length > 0) await putBatch(STORES.TABS, upsertTabs);
  if (removedIds.length > 0) {
    for (const id of removedIds) {
      try { await remove(STORES.TABS, id); } catch (e) { /* ignore */ }
    }
  }

  console.log(`[TabVault Monitor] Reconciled: +${upsertTabs.length} updated, -${removedIds.length} removed`);
}

/**
 * Sync all tabs from Chrome (full refresh)
 */
async function syncFromChrome() {
  const chromeTabs = await chrome.tabs.query({});
  tabCache.clear();

  const tabRecords = chromeTabs.map(chromeTabToRecord);
  tabRecords.forEach(t => tabCache.set(t.id, t));

  await putBatch(STORES.TABS, tabRecords);
  console.log(`[TabVault Monitor] Full sync: ${tabRecords.length} tabs`);
}

/**
 * Convert a Chrome tab object to our storage record
 */
function chromeTabToRecord(chromeTab) {
  return {
    id: chromeTab.id,
    windowId: chromeTab.windowId,
    url: chromeTab.url || chromeTab.pendingUrl || '',
    title: chromeTab.title || 'Untitled',
    favIconUrl: chromeTab.favIconUrl || '',
    domain: extractDomain(chromeTab.url || chromeTab.pendingUrl || ''),
    index: chromeTab.index,
    pinned: chromeTab.pinned,
    active: chromeTab.active,
    status: chromeTab.status, // 'loading', 'complete'
    discarded: chromeTab.discarded,
    autoDiscardable: chromeTab.autoDiscardable,
    groupId: chromeTab.groupId,
    audible: chromeTab.audible,
    mutedInfo: chromeTab.mutedInfo,
    lastAccessed: chromeTab.lastAccessed || Date.now(),
    trackedAt: Date.now()
  };
}

// ===== EVENT HANDLERS =====

/**
 * Handle tab created
 */
async function onTabCreated(chromeTab) {
  const tabData = chromeTabToRecord(chromeTab);
  tabCache.set(chromeTab.id, tabData);
  await put(STORES.TABS, tabData);
}

/**
 * Handle tab updated (URL change, title change, etc.)
 */
async function onTabUpdated(tabId, changeInfo, chromeTab) {
  const existing = tabCache.get(tabId) || {};
  const tabData = {
    ...existing,
    ...chromeTabToRecord(chromeTab),
  };
  tabCache.set(tabId, tabData);
  await put(STORES.TABS, tabData);
}

/**
 * Handle tab removed
 */
async function onTabRemoved(tabId, removeInfo) {
  tabCache.delete(tabId);
  try {
    await remove(STORES.TABS, tabId);
  } catch (e) { /* tab may not exist in DB */ }
}

/**
 * Handle tab moved within a window
 */
async function onTabMoved(tabId, moveInfo) {
  const existing = tabCache.get(tabId);
  if (existing) {
    existing.index = moveInfo.toIndex;
    existing.windowId = moveInfo.windowId;
    tabCache.set(tabId, existing);
    await put(STORES.TABS, existing);
  }
}

/**
 * Handle tab attached to a window
 */
async function onTabAttached(tabId, attachInfo) {
  const existing = tabCache.get(tabId);
  if (existing) {
    existing.windowId = attachInfo.newWindowId;
    existing.index = attachInfo.newPosition;
    tabCache.set(tabId, existing);
    await put(STORES.TABS, existing);
  }
}

/**
 * Handle tab activated (user switched to it)
 */
async function onTabActivated(activeInfo) {
  // Mark previous active tab as inactive
  for (const [id, tab] of tabCache) {
    if (tab.windowId === activeInfo.windowId && tab.active) {
      tab.active = false;
      tabCache.set(id, tab);
    }
  }

  // Mark new active tab
  const tab = tabCache.get(activeInfo.tabId);
  if (tab) {
    tab.active = true;
    tab.lastAccessed = Date.now();
    tabCache.set(activeInfo.tabId, tab);
    await put(STORES.TABS, tab);
  }
}

// ===== QUERY METHODS =====

/**
 * Get all tracked tabs (from cache)
 */
function getAllTabs() {
  return Array.from(tabCache.values());
}

/**
 * Get tabs for a specific window
 */
function getTabsByWindow(windowId) {
  return Array.from(tabCache.values()).filter(t => t.windowId === windowId);
}

/**
 * Get tabs by group
 */
function getTabsByGroup(groupId) {
  return Array.from(tabCache.values()).filter(t => t.groupId === groupId);
}

/**
 * Find duplicate tabs (same URL)
 */
function findDuplicates() {
  const urlMap = new Map();
  const duplicates = [];

  for (const tab of tabCache.values()) {
    if (!tab.url || tab.url === 'chrome://newtab/') continue;
    
    const normalizedUrl = normalizeUrl(tab.url);
    if (urlMap.has(normalizedUrl)) {
      urlMap.get(normalizedUrl).push(tab);
    } else {
      urlMap.set(normalizedUrl, [tab]);
    }
  }

  for (const [url, tabs] of urlMap) {
    if (tabs.length > 1) {
      duplicates.push({ url, tabs, count: tabs.length });
    }
  }

  return duplicates;
}

/**
 * Normalize URL for duplicate comparison
 */
function normalizeUrl(url) {
  try {
    const u = new URL(url);
    // Remove trailing slash and hash
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/$/, '')}${u.search}`;
  } catch {
    return url;
  }
}

/**
 * Get tab statistics
 */
function getTabStats() {
  const tabs = Array.from(tabCache.values());
  const windows = new Set(tabs.map(t => t.windowId));
  const groups = new Set(tabs.filter(t => t.groupId > 0).map(t => t.groupId));
  const domains = new Map();

  tabs.forEach(t => {
    if (t.domain) {
      domains.set(t.domain, (domains.get(t.domain) || 0) + 1);
    }
  });

  const topDomains = Array.from(domains.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  return {
    totalTabs: tabs.length,
    totalWindows: windows.size,
    totalGroups: groups.size,
    suspendedTabs: tabs.filter(t => t.discarded).length,
    activeTabs: tabs.filter(t => !t.discarded).length,
    pinnedTabs: tabs.filter(t => t.pinned).length,
    audibleTabs: tabs.filter(t => t.audible).length,
    duplicateCount: findDuplicates().reduce((sum, d) => sum + d.count - 1, 0),
    topDomains
  };
}

export {
  initTabMonitor,
  reconcileTabs,
  syncFromChrome,
  onTabCreated,
  onTabUpdated,
  onTabRemoved,
  onTabMoved,
  onTabAttached,
  onTabActivated,
  getAllTabs,
  getTabsByWindow,
  getTabsByGroup,
  findDuplicates,
  getTabStats,
  autoGroupTabs
};

// ===== AUTO-GROUPING (PRO) =====
async function autoGroupTabs() {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const domainMap = {};
  
  tabs.forEach(tab => {
    if (tab.pinned || tab.groupId !== -1) return; // skip pinned or already grouped tabs
    try {
      const url = new URL(tab.url);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
      
      let domain = url.hostname.replace('www.', '');
      if (!domainMap[domain]) domainMap[domain] = [];
      domainMap[domain].push(tab.id);
    } catch(e){}
  });
  
  let groupsCreated = 0;
  const colors = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan'];
  
  for (const domain in domainMap) {
    if (domainMap[domain].length >= 2) {
      const tabIds = domainMap[domain];
      const groupId = await chrome.tabs.group({ tabIds });
      
      // Try to set a title and color based on domain
      const title = domain.split('.')[0].toUpperCase();
      const color = colors[groupsCreated % colors.length];
      
      await chrome.tabGroups.update(groupId, { title, color });
      groupsCreated++;
    }
  }
  return { groups: groupsCreated };
}
