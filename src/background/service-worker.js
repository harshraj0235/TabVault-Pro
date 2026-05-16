/**
 * TabVault Pro — Main Service Worker
 * Event-driven, persistence-first architecture.
 * No global state reliance — re-hydrates from IndexedDB on every wake.
 */

import { openDatabase, replayWAL, cleanWAL } from '../storage/db.js';
import { createBackup, setupAutoBackup, isBackupNeeded, exportToJSON, importFromJSON } from '../storage/backup.js';
import { initTabMonitor, onTabCreated, onTabUpdated, onTabRemoved, onTabMoved, onTabAttached, onTabActivated, getAllTabs, getTabsByWindow, findDuplicates, getTabStats, autoGroupTabs } from './tab-monitor.js';
import { saveSession, saveCrashSnapshot, saveAutoSession, restoreSession, getSessions, deleteSession, renameSession, createWorkspace, getWorkspaces, updateWorkspace, deleteWorkspace, saveTabToWorkspace, checkLimits } from './session-manager.js';
import { runSuspensionCheck, suspendTab, suspendAllInactive, getMemorySavings, getSuspenderSettings, updateSuspenderSettings, setupSuspensionAlarm } from './suspender.js';
import { isPro, setProStatus } from '../premium/license.js';

// ===== INITIALIZATION =====

async function initialize() {
  console.log('[TabVault Pro] Service Worker starting...');
  try {
    await openDatabase();
    await replayWAL(); // Recover any uncommitted writes
    await initTabMonitor();
    
    // Enable side panel on click
    if (chrome.sidePanel) {
      chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
    }

    setupAutoBackup();
    setupSuspensionAlarm();
    // Save crash snapshot on startup (in case we're recovering)
    await saveCrashSnapshot();
    await cleanWAL();
    console.log('[TabVault Pro] Initialized successfully');
  } catch (error) {
    console.error('[TabVault Pro] Init error:', error?.name, error?.message, error);
  }
}

// Initialize on install
chrome.runtime.onInstalled.addListener(async (details) => {
  await initialize();
  if (details.reason === 'install') {
    await createWorkspace('Default', '#6366f1');
    console.log('[TabVault Pro] Fresh install — created default workspace');
    chrome.tabs.create({ url: chrome.runtime.getURL('src/popup/onboarding.html') });
  }
});

// Initialize on browser startup
chrome.runtime.onStartup.addListener(initialize);

// ===== TAB EVENT LISTENERS =====

chrome.tabs.onCreated.addListener(async (tab) => {
  try { await onTabCreated(tab); } catch (e) { console.error('[TabVault] onCreated error:', e); }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' || changeInfo.title || changeInfo.url) {
    
    // Razorpay Redirect Listener (Method 1)
    if (changeInfo.url && changeInfo.url.includes('tabvault_pro_success=true')) {
      console.log('[TabVault Pro] Payment success detected! Unlocking Pro...');
      await setProStatus(true);
      
      // Notify the user
      chrome.notifications.create({
        type: 'basic',
        iconUrl: '../icons/icon128.png',
        title: 'TabVault Pro Unlocked! 🚀',
        message: 'Thank you for your purchase. All Pro features are now available.'
      });
      
      // Optional: close the success tab after 3 seconds
      setTimeout(() => chrome.tabs.remove(tabId).catch(() => {}), 3000);
    }

    try { await onTabUpdated(tabId, changeInfo, tab); } catch (e) { console.error('[TabVault] onUpdated error:', e); }
    
    // Capture thumbnail
    if (tab.active && !tab.url.startsWith('chrome://')) {
      setTimeout(() => captureTabThumbnail(tabId), 1500);
    }
  }
});

chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  try { await onTabRemoved(tabId, removeInfo); } catch (e) { console.error('[TabVault] onRemoved error:', e); }
});

chrome.tabs.onMoved.addListener(async (tabId, moveInfo) => {
  try { await onTabMoved(tabId, moveInfo); } catch (e) { console.error('[TabVault] onMoved error:', e); }
});

chrome.tabs.onAttached.addListener(async (tabId, attachInfo) => {
  try { await onTabAttached(tabId, attachInfo); } catch (e) { console.error('[TabVault] onAttached error:', e); }
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try { await onTabActivated(activeInfo); } catch (e) { console.error('[TabVault] onActivated error:', e); }
  
  // Capture thumbnail
  setTimeout(() => captureTabThumbnail(activeInfo.tabId), 1500);
});

// ===== ALARM HANDLERS =====

chrome.alarms.onAlarm.addListener(async (alarm) => {
  // Re-init if needed (SW may have been terminated)
  await initTabMonitor();

  switch (alarm.name) {
    case 'tabvault-auto-backup':
      if (await isBackupNeeded()) {
        await createBackup();
        await saveAutoSession();
      }
      break;
    case 'tabvault-suspension-check':
      await runSuspensionCheck();
      await checkSnoozedTabs();
      break;
  }
});

// ===== MESSAGE HANDLER (Popup <-> SW communication) =====

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message).then(sendResponse).catch(err => {
    console.error('[TabVault] Message error:', err);
    sendResponse({ error: err.message });
  });
  return true; // Keep channel open for async response
});

async function handleMessage(msg) {
  // Ensure initialized
  await initTabMonitor();

  switch (msg.action) {
    // Tab queries
    case 'getTabs': return getAllTabs();
    case 'getTabsByWindow': return getTabsByWindow(msg.windowId);
    case 'getTabStats': return getTabStats();
    case 'findDuplicates': return findDuplicates();

    // Tab actions
    case 'switchToTab':
      await chrome.tabs.update(msg.tabId, { active: true });
      await chrome.windows.update(msg.windowId, { focused: true });
      return { success: true };
    case 'closeTab':
      await chrome.tabs.remove(msg.tabId);
      return { success: true };
    case 'closeTabs':
      await chrome.tabs.remove(msg.tabIds);
      return { success: true };
    case 'pinTab':
      await chrome.tabs.update(msg.tabId, { pinned: msg.pinned });
      return { success: true };
    case 'suspendTab':
      return { success: await suspendTab(msg.tabId) };
    case 'suspendAll':
      return { suspended: await suspendAllInactive() };
    case 'closeDuplicates': {
      const dupes = findDuplicates();
      const idsToClose = [];
      dupes.forEach(d => {
        d.tabs.slice(1).forEach(t => idsToClose.push(t.id));
      });
      if (idsToClose.length > 0) await chrome.tabs.remove(idsToClose);
      return { closed: idsToClose.length };
    }
    case 'autoGroupTabs':
      return await autoGroupTabs();
    case 'snoozeTab':
      return await snoozeTab(msg.tabId, msg.minutes);
    case 'getThumbnail':
      const { get } = await import('../storage/db.js');
      return await get('thumbnails', msg.url);
    // Sessions
    case 'saveSession':
      return await saveSession(msg.name, 'manual', msg.workspaceId);
    case 'getSessions':
      return await getSessions(msg.filter || {});
    case 'restoreSession':
      return await restoreSession(msg.sessionId, msg.options || {});
    case 'deleteSession':
      await deleteSession(msg.sessionId);
      return { success: true };
    case 'renameSession':
      await renameSession(msg.sessionId, msg.name);
      return { success: true };

    // Workspaces
    case 'getWorkspaces': return await getWorkspaces();
    case 'createWorkspace':
      return await createWorkspace(msg.name, msg.color);
    case 'updateWorkspace':
      return await updateWorkspace(msg.workspaceId, msg.updates);
    case 'deleteWorkspace':
      await deleteWorkspace(msg.workspaceId);
      return { success: true };
    case 'saveTabToWorkspace':
      return await saveTabToWorkspace(msg.tabId, msg.workspaceId);

    // Suspender
    case 'getSuspenderSettings': return await getSuspenderSettings();
    case 'updateSuspenderSettings':
      return await updateSuspenderSettings(msg.settings);
    case 'getMemorySavings': return getMemorySavings();

    // Data
    case 'exportData':
      return await exportToJSON();
    case 'importData':
      return await importFromJSON(msg.data);

    // Limits
    case 'checkLimits':
      return await checkLimits(await isPro());

    // License
    case 'activatePro':
      await setProStatus(true);
      return { success: true };
    case 'isPro': return await isPro();

    // AI Features
    case 'semanticSearch': {
      const settings = await getSuspenderSettings();
      const apiKey = settings.geminiKey;
      if (!apiKey) return { error: 'No API Key' };
      
      try {
        const ai = await import('./ai.js');
        const tabs = await getTabs();
        const ids = await ai.semanticSearch(msg.query, tabs, apiKey);
        return { success: true, ids };
      } catch (err) {
        return { error: err.message };
      }
    }

    default:
      return { error: 'Unknown action: ' + msg.action };
  }
}

// ===== COMMAND SHORTCUTS =====

chrome.commands.onCommand.addListener(async (command) => {
  switch (command) {
    case 'save-session':
      await initTabMonitor();
      await saveSession('Quick Save', 'manual');
      break;
  }
});

// ===== SNOOZE TABS =====
async function checkSnoozedTabs() {
  const { getAll, remove } = await import('../storage/db.js');
  const snoozed = await getAll('snoozed_tabs');
  if (!snoozed) return;
  const now = Date.now();
  for (const tab of snoozed) {
    if (now >= tab.wakeTime) {
      await chrome.tabs.create({ url: tab.url, active: false });
      await remove('snoozed_tabs', tab.id);
    }
  }
}

async function snoozeTab(tabId, minutes) {
  const { get, put, generateId } = await import('../storage/db.js');
  const tab = await get('tabs', tabId);
  if (!tab) return { success: false };
  
  const wakeTime = Date.now() + (minutes * 60000);
  await put('snoozed_tabs', {
    id: generateId(),
    url: tab.url,
    title: tab.title,
    wakeTime
  });
  
  await chrome.tabs.remove(tabId);
  return { success: true };
}

// ===== THUMBNAIL CAPTURE =====
async function captureTabThumbnail(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab || !tab.active || !tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('edge://')) return;
    
    // Capture the visible tab (scaled down to save memory)
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 10 });
    
    if (dataUrl) {
      const { put } = await import('../storage/db.js');
      await put('thumbnails', { url: tab.url, dataUrl, timestamp: Date.now() });
    }
  } catch (e) {
    // Ignore errors (tab closed before capture, etc)
  }
}
