/**
 * TabVault Pro — Backup & Recovery Layer
 * 
 * Mirrors critical data to chrome.storage.local as redundant backup.
 * Provides JSON export/import for user-controlled backups.
 * Auto-snapshots every 30 minutes.
 */

import { STORES, getAll, putBatch, clear } from './db.js';

const BACKUP_KEY = 'tabvault_backup';
const BACKUP_TIMESTAMP_KEY = 'tabvault_backup_timestamp';
const BACKUP_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Create a full backup of critical data to chrome.storage.local
 */
async function createBackup() {
  try {
    const [tabs, sessions, workspaces, settings] = await Promise.all([
      getAll(STORES.TABS),
      getAll(STORES.SESSIONS),
      getAll(STORES.WORKSPACES),
      getAll(STORES.SETTINGS)
    ]);

    const backup = {
      version: 1,
      timestamp: Date.now(),
      data: { tabs, sessions, workspaces, settings }
    };

    // chrome.storage.local has 10MB limit — compress by removing unnecessary fields
    const compactBackup = compactData(backup);

    await chrome.storage.local.set({
      [BACKUP_KEY]: compactBackup,
      [BACKUP_TIMESTAMP_KEY]: Date.now()
    });

    console.log(`[TabVault Backup] Created backup: ${tabs.length} tabs, ${sessions.length} sessions, ${workspaces.length} workspaces`);
    return backup;
  } catch (error) {
    console.error('[TabVault Backup] Failed to create backup:', error);
    throw error;
  }
}

/**
 * Restore data from chrome.storage.local backup
 */
async function restoreFromBackup() {
  try {
    const result = await chrome.storage.local.get([BACKUP_KEY, BACKUP_TIMESTAMP_KEY]);
    const backup = result[BACKUP_KEY];

    if (!backup || !backup.data) {
      console.warn('[TabVault Backup] No backup found');
      return null;
    }

    const { tabs, sessions, workspaces, settings } = backup.data;

    // Clear existing data and restore
    await Promise.all([
      clear(STORES.TABS),
      clear(STORES.SESSIONS),
      clear(STORES.WORKSPACES),
      clear(STORES.SETTINGS)
    ]);

    await Promise.all([
      tabs.length > 0 ? putBatch(STORES.TABS, tabs) : Promise.resolve(),
      sessions.length > 0 ? putBatch(STORES.SESSIONS, sessions) : Promise.resolve(),
      workspaces.length > 0 ? putBatch(STORES.WORKSPACES, workspaces) : Promise.resolve(),
      settings.length > 0 ? putBatch(STORES.SETTINGS, settings) : Promise.resolve()
    ]);

    console.log(`[TabVault Backup] Restored from backup (${new Date(backup.timestamp).toLocaleString()})`);
    return backup;
  } catch (error) {
    console.error('[TabVault Backup] Failed to restore from backup:', error);
    throw error;
  }
}

/**
 * Check if a backup exists and its age
 */
async function getBackupInfo() {
  try {
    const result = await chrome.storage.local.get([BACKUP_KEY, BACKUP_TIMESTAMP_KEY]);
    const backup = result[BACKUP_KEY];

    if (!backup) {
      return { exists: false, timestamp: null, age: null, tabCount: 0, sessionCount: 0 };
    }

    return {
      exists: true,
      timestamp: backup.timestamp,
      age: Date.now() - backup.timestamp,
      tabCount: backup.data?.tabs?.length || 0,
      sessionCount: backup.data?.sessions?.length || 0,
      workspaceCount: backup.data?.workspaces?.length || 0
    };
  } catch (error) {
    return { exists: false, timestamp: null, age: null, tabCount: 0, sessionCount: 0 };
  }
}

/**
 * Export all data as a downloadable JSON file
 */
async function exportToJSON() {
  try {
    const [tabs, sessions, workspaces, settings] = await Promise.all([
      getAll(STORES.TABS),
      getAll(STORES.SESSIONS),
      getAll(STORES.WORKSPACES),
      getAll(STORES.SETTINGS)
    ]);

    const exportData = {
      app: 'TabVault Pro',
      version: '1.0.0',
      exportedAt: new Date().toISOString(),
      timestamp: Date.now(),
      data: { tabs, sessions, workspaces, settings },
      stats: {
        tabCount: tabs.length,
        sessionCount: sessions.length,
        workspaceCount: workspaces.length
      }
    };

    return JSON.stringify(exportData, null, 2);
  } catch (error) {
    console.error('[TabVault Backup] Export failed:', error);
    throw error;
  }
}

/**
 * Import data from a JSON string
 */
async function importFromJSON(jsonString) {
  try {
    const importData = JSON.parse(jsonString);

    if (!importData.app || importData.app !== 'TabVault Pro') {
      throw new Error('Invalid TabVault Pro export file');
    }

    const { tabs, sessions, workspaces, settings } = importData.data;

    // Merge with existing data (don't overwrite)
    if (tabs?.length > 0) await putBatch(STORES.TABS, tabs);
    if (sessions?.length > 0) await putBatch(STORES.SESSIONS, sessions);
    if (workspaces?.length > 0) await putBatch(STORES.WORKSPACES, workspaces);
    if (settings?.length > 0) await putBatch(STORES.SETTINGS, settings);

    console.log(`[TabVault Backup] Imported: ${tabs?.length || 0} tabs, ${sessions?.length || 0} sessions`);
    return importData.stats;
  } catch (error) {
    console.error('[TabVault Backup] Import failed:', error);
    throw error;
  }
}

/**
 * Compact data to reduce storage size
 * Removes transient fields that can be regenerated
 */
function compactData(backup) {
  const compact = JSON.parse(JSON.stringify(backup));
  
  // Remove large transient fields from tab records
  if (compact.data?.tabs) {
    compact.data.tabs = compact.data.tabs.map(tab => ({
      id: tab.id,
      url: tab.url,
      title: tab.title,
      favIconUrl: tab.favIconUrl,
      windowId: tab.windowId,
      groupId: tab.groupId,
      domain: tab.domain,
      pinned: tab.pinned,
      lastAccessed: tab.lastAccessed
    }));
  }

  return compact;
}

/**
 * Setup auto-backup alarm
 */
function setupAutoBackup() {
  chrome.alarms.create('tabvault-auto-backup', {
    periodInMinutes: 5 // Every 5 minutes
  });
  
  console.log('[TabVault Backup] Auto-backup alarm set (every 5 minutes)');
}

/**
 * Check if backup is needed (older than interval)
 */
async function isBackupNeeded() {
  const result = await chrome.storage.local.get(BACKUP_TIMESTAMP_KEY);
  const lastBackup = result[BACKUP_TIMESTAMP_KEY] || 0;
  return (Date.now() - lastBackup) > BACKUP_INTERVAL_MS;
}

export {
  createBackup,
  restoreFromBackup,
  getBackupInfo,
  exportToJSON,
  importFromJSON,
  setupAutoBackup,
  isBackupNeeded
};
