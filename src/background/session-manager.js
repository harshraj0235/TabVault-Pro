/**
 * TabVault Pro — Session Manager
 * 
 * Save, restore, and manage browsing sessions.
 * Auto-saves crash recovery snapshots.
 * Supports named sessions and workspace grouping.
 */

import { STORES, put, putBatch, get, getAll, getByIndex, remove, count, generateId } from '../storage/db.js';
import { getAllTabs } from './tab-monitor.js';

const MAX_FREE_SESSIONS = 10;
const MAX_FREE_WORKSPACES = 3;
const SESSION_HISTORY_DAYS_FREE = 7;

/**
 * Save current session (all open tabs across all windows)
 */
async function saveSession(name = null, type = 'manual', workspaceId = null) {
  const tabs = getAllTabs();
  
  if (tabs.length === 0) {
    console.warn('[TabVault Session] No tabs to save');
    return null;
  }

  // Group tabs by window
  const windows = {};
  tabs.forEach(tab => {
    if (!windows[tab.windowId]) {
      windows[tab.windowId] = [];
    }
    windows[tab.windowId].push({
      url: tab.url,
      title: tab.title,
      favIconUrl: tab.favIconUrl,
      domain: tab.domain,
      pinned: tab.pinned,
      groupId: tab.groupId,
      index: tab.index
    });
  });

  const session = {
    id: generateId(),
    name: name || `Session ${new Date().toLocaleString()}`,
    type, // 'manual', 'auto', 'crash'
    workspaceId,
    windows,
    tabCount: tabs.length,
    windowCount: Object.keys(windows).length,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };

  await put(STORES.SESSIONS, session);
  console.log(`[TabVault Session] Saved "${session.name}": ${session.tabCount} tabs in ${session.windowCount} windows`);
  return session;
}

/**
 * Save crash recovery snapshot (auto-called periodically)
 */
async function saveCrashSnapshot() {
  // Keep only last 5 crash snapshots
  const crashSessions = await getByIndex(STORES.SESSIONS, 'type', 'crash');
  
  if (crashSessions.length >= 5) {
    // Remove oldest
    const sorted = crashSessions.sort((a, b) => a.createdAt - b.createdAt);
    for (let i = 0; i < sorted.length - 4; i++) {
      await remove(STORES.SESSIONS, sorted[i].id);
    }
  }

  return await saveSession('Crash Recovery Snapshot', 'crash');
}

/**
 * Save auto-session (periodic auto-save)
 */
async function saveAutoSession() {
  // Keep only last 10 auto sessions
  const autoSessions = await getByIndex(STORES.SESSIONS, 'type', 'auto');
  
  if (autoSessions.length >= 10) {
    const sorted = autoSessions.sort((a, b) => a.createdAt - b.createdAt);
    for (let i = 0; i < sorted.length - 9; i++) {
      await remove(STORES.SESSIONS, sorted[i].id);
    }
  }

  return await saveSession('Auto-Save', 'auto');
}

/**
 * Restore a session — open all tabs from a saved session
 */
async function restoreSession(sessionId, options = {}) {
  const session = await get(STORES.SESSIONS, sessionId);
  if (!session) {
    throw new Error('Session not found');
  }

  const {
    replaceCurrentSession = false, // Close current tabs before restoring
    openInNewWindow = false        // Open restored tabs in a new window
  } = options;

  if (replaceCurrentSession) {
    // Close all current tabs except one (Chrome requires at least one)
    const currentTabs = await chrome.tabs.query({});
    if (currentTabs.length > 1) {
      const tabIds = currentTabs.slice(1).map(t => t.id);
      await chrome.tabs.remove(tabIds);
    }
  }

  let restoredCount = 0;

  for (const [windowId, tabs] of Object.entries(session.windows)) {
    if (openInNewWindow || Object.keys(session.windows).length > 1) {
      // Create a new window for each saved window
      const urls = tabs.map(t => t.url).filter(u => u && !u.startsWith('chrome://'));
      if (urls.length > 0) {
        const newWindow = await chrome.windows.create({ url: urls[0] });
        // Add remaining tabs
        for (let i = 1; i < urls.length; i++) {
          await chrome.tabs.create({
            windowId: newWindow.id,
            url: urls[i],
            active: false,
            pinned: tabs[i]?.pinned || false
          });
        }
        restoredCount += urls.length;
      }
    } else {
      // Open tabs in current window
      for (const tab of tabs) {
        if (tab.url && !tab.url.startsWith('chrome://')) {
          await chrome.tabs.create({
            url: tab.url,
            active: false,
            pinned: tab.pinned || false
          });
          restoredCount++;
        }
      }
    }
  }

  console.log(`[TabVault Session] Restored "${session.name}": ${restoredCount} tabs`);
  return { session, restoredCount };
}

/**
 * Get all sessions, optionally filtered
 */
async function getSessions(filter = {}) {
  let sessions = await getAll(STORES.SESSIONS);

  if (filter.type) {
    sessions = sessions.filter(s => s.type === filter.type);
  }

  if (filter.workspaceId) {
    sessions = sessions.filter(s => s.workspaceId === filter.workspaceId);
  }

  // Sort by creation date, newest first
  sessions.sort((a, b) => b.createdAt - a.createdAt);

  return sessions;
}

/**
 * Delete a session
 */
async function deleteSession(sessionId) {
  await remove(STORES.SESSIONS, sessionId);
  console.log(`[TabVault Session] Deleted session ${sessionId}`);
}

/**
 * Rename a session
 */
async function renameSession(sessionId, newName) {
  const session = await get(STORES.SESSIONS, sessionId);
  if (session) {
    session.name = newName;
    session.updatedAt = Date.now();
    await put(STORES.SESSIONS, session);
  }
}

// ===== WORKSPACE MANAGEMENT =====

/**
 * Create a new workspace
 */
async function createWorkspace(name, color = '#6366f1') {
  const workspaces = await getAll(STORES.WORKSPACES);
  
  const workspace = {
    id: generateId(),
    name,
    color,
    order: workspaces.length,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };

  await put(STORES.WORKSPACES, workspace);
  console.log(`[TabVault Session] Created workspace "${name}"`);
  return workspace;
}

/**
 * Get all workspaces
 */
async function getWorkspaces() {
  const workspaces = await getAll(STORES.WORKSPACES);
  return workspaces.sort((a, b) => a.order - b.order);
}

/**
 * Update a workspace
 */
async function updateWorkspace(workspaceId, updates) {
  const workspace = await get(STORES.WORKSPACES, workspaceId);
  if (workspace) {
    Object.assign(workspace, updates, { updatedAt: Date.now() });
    await put(STORES.WORKSPACES, workspace);
  }
  return workspace;
}

/**
 * Delete a workspace and its sessions
 */
async function deleteWorkspace(workspaceId) {
  await remove(STORES.WORKSPACES, workspaceId);
  
  // Also delete all sessions in this workspace
  const sessions = await getByIndex(STORES.SESSIONS, 'workspaceId', workspaceId);
  for (const session of sessions) {
    await remove(STORES.SESSIONS, session.id);
  }
  console.log(`[TabVault Session] Deleted workspace ${workspaceId} and ${sessions.length} sessions`);
}

/**
 * Check if user can create more sessions/workspaces (free tier limits)
 */
async function checkLimits(isPro = false) {
  if (isPro) {
    return { canCreateSession: true, canCreateWorkspace: true };
  }

  const sessionCount = await count(STORES.SESSIONS);
  const workspaceCount = await count(STORES.WORKSPACES);

  return {
    canCreateSession: sessionCount < MAX_FREE_SESSIONS,
    canCreateWorkspace: workspaceCount < MAX_FREE_WORKSPACES,
    sessionCount,
    sessionLimit: MAX_FREE_SESSIONS,
    workspaceCount,
    workspaceLimit: MAX_FREE_WORKSPACES
  };
}

/**
 * Save a single tab to a workspace via Drag & Drop
 */
async function saveTabToWorkspace(tabId, workspaceId) {
  // We need to import 'get' from db.js since session-manager might not have it... Wait, session-manager imports put, get, getByIndex, getAll, remove, generateId from db.js
  const { get, put, getByIndex, generateId } = await import('../storage/db.js');
  
  const tab = await get('tabs', tabId);
  if (!tab) return { success: false };
  
  const sessions = await getByIndex('sessions', 'workspaceId', workspaceId);
  let session = sessions.find(s => s.name === 'Saved Tabs') || sessions[0];
  
  if (!session) {
    session = {
      id: generateId(),
      name: 'Saved Tabs',
      type: 'manual',
      createdAt: Date.now(),
      workspaceId,
      tabCount: 0,
      windowCount: 1,
      windows: { 1: [] }
    };
  }
  
  const windowId = Object.keys(session.windows)[0];
  session.windows[windowId].push({
    url: tab.url,
    title: tab.title,
    favIconUrl: tab.favIconUrl,
    pinned: false
  });
  session.tabCount++;
  session.createdAt = Date.now();
  
  await put('sessions', session);
  return { success: true };
}

export {
  saveSession,
  saveCrashSnapshot,
  saveAutoSession,
  restoreSession,
  getSessions,
  deleteSession,
  renameSession,
  createWorkspace,
  getWorkspaces,
  updateWorkspace,
  deleteWorkspace,
  saveTabToWorkspace,
  checkLimits
};
