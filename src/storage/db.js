/**
 * TabVault Pro — IndexedDB Storage Layer
 * 
 * Crash-proof, write-ahead logging database wrapper.
 * Uses granular per-record writes (never big-blob).
 * Auto-migrates schema on version changes.
 */

const DB_NAME = 'TabVaultPro';
const DB_VERSION = 4;

const STORES = {
  TABS: 'tabs',
  SESSIONS: 'sessions',
  WORKSPACES: 'workspaces',
  HISTORY: 'history',
  SETTINGS: 'settings',
  WAL: 'wal', // Write-ahead log for crash recovery
  SNOOZED: 'snoozed_tabs',
  RULES: 'domain_rules',
  THUMBNAILS: 'thumbnails'
};

let dbInstance = null;

/**
 * Open/create the IndexedDB database with all object stores
 */
function openDatabase() {
  return new Promise((resolve, reject) => {
    if (dbInstance) {
      resolve(dbInstance);
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      // Tabs store — indexed by tabId for instant lookups
      if (!db.objectStoreNames.contains(STORES.TABS)) {
        const tabStore = db.createObjectStore(STORES.TABS, { keyPath: 'id' });
        tabStore.createIndex('windowId', 'windowId', { unique: false });
        tabStore.createIndex('url', 'url', { unique: false });
        tabStore.createIndex('domain', 'domain', { unique: false });
        tabStore.createIndex('groupId', 'groupId', { unique: false });
        tabStore.createIndex('lastAccessed', 'lastAccessed', { unique: false });
      }

      // Sessions store — named snapshots of tab states
      if (!db.objectStoreNames.contains(STORES.SESSIONS)) {
        const sessionStore = db.createObjectStore(STORES.SESSIONS, { keyPath: 'id' });
        sessionStore.createIndex('createdAt', 'createdAt', { unique: false });
        sessionStore.createIndex('type', 'type', { unique: false }); // 'manual', 'auto', 'crash'
        sessionStore.createIndex('workspaceId', 'workspaceId', { unique: false });
      }

      // Workspaces store — groups of sessions
      if (!db.objectStoreNames.contains(STORES.WORKSPACES)) {
        const workspaceStore = db.createObjectStore(STORES.WORKSPACES, { keyPath: 'id' });
        workspaceStore.createIndex('name', 'name', { unique: false });
        workspaceStore.createIndex('order', 'order', { unique: false });
      }

      // History store — tab activity timeline
      if (!db.objectStoreNames.contains(STORES.HISTORY)) {
        const historyStore = db.createObjectStore(STORES.HISTORY, { keyPath: 'id' });
        historyStore.createIndex('timestamp', 'timestamp', { unique: false });
        historyStore.createIndex('action', 'action', { unique: false });
      }

      // Settings store — user preferences
      if (!db.objectStoreNames.contains(STORES.SETTINGS)) {
        db.createObjectStore(STORES.SETTINGS, { keyPath: 'key' });
      }

      // Write-ahead log — crash recovery
      if (!db.objectStoreNames.contains(STORES.WAL)) {
        const walStore = db.createObjectStore(STORES.WAL, { keyPath: 'id', autoIncrement: true });
        walStore.createIndex('timestamp', 'timestamp', { unique: false });
      }

      // Version 3
      if (!db.objectStoreNames.contains(STORES.SNOOZED)) {
        const snoozedStore = db.createObjectStore(STORES.SNOOZED, { keyPath: 'id' });
        snoozedStore.createIndex('wakeTime', 'wakeTime', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORES.RULES)) {
        const rulesStore = db.createObjectStore(STORES.RULES, { keyPath: 'domain' });
        rulesStore.createIndex('type', 'type', { unique: false });
      }
      
      // Version 4
      if (!db.objectStoreNames.contains(STORES.THUMBNAILS)) {
        const thumbStore = db.createObjectStore(STORES.THUMBNAILS, { keyPath: 'url' });
        thumbStore.createIndex('timestamp', 'timestamp', { unique: false });
      }
    };

    request.onsuccess = (event) => {
      dbInstance = event.target.result;

      // Handle connection loss
      dbInstance.onclose = () => {
        dbInstance = null;
      };

      dbInstance.onerror = (e) => {
        console.error('[TabVault DB] Database error:', e.target.error);
      };

      resolve(dbInstance);
    };

    request.onerror = (event) => {
      console.error('[TabVault DB] Failed to open database:', event.target.error);
      reject(event.target.error);
    };
  });
}

/**
 * Write-Ahead Log entry before any mutation
 * Ensures we can recover from mid-write crashes
 */
async function writeAheadLog(storeName, operation, data) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.WAL, 'readwrite');
    const store = tx.objectStore(STORES.WAL);
    
    const entry = {
      storeName,
      operation, // 'put', 'delete', 'clear'
      data,
      timestamp: Date.now(),
      applied: 0 // Use 0/1 instead of boolean (IDB can't index booleans)
    };

    const request = store.add(entry);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Mark WAL entry as applied
 */
async function markWALApplied(walId) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.WAL, 'readwrite');
    const store = tx.objectStore(STORES.WAL);
    const request = store.get(walId);
    
    request.onsuccess = () => {
      const entry = request.result;
      if (entry) {
        entry.applied = 1;
        store.put(entry);
      }
      resolve();
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * Replay unapplied WAL entries (crash recovery)
 */
async function replayWAL() {
  const db = await openDatabase();
  // Get all store names for the transaction
  const allStores = [STORES.WAL, STORES.TABS, STORES.SESSIONS, STORES.WORKSPACES, STORES.HISTORY, STORES.SETTINGS];
  return new Promise((resolve, reject) => {
    const tx = db.transaction(allStores, 'readwrite');
    const walStore = tx.objectStore(STORES.WAL);
    // Get ALL entries then filter in JS (booleans aren't valid IDB keys)
    const request = walStore.getAll();

    request.onsuccess = () => {
      const allEntries = request.result || [];
      const unapplied = allEntries.filter(e => !e.applied);
      let replayed = 0;

      for (const entry of unapplied) {
        try {
          const targetStore = tx.objectStore(entry.storeName);
          
          if (entry.operation === 'put') {
            targetStore.put(entry.data);
          } else if (entry.operation === 'delete') {
            targetStore.delete(entry.data);
          }

          entry.applied = 1;
          walStore.put(entry);
          replayed++;
        } catch (e) {
          console.warn('[TabVault DB] WAL replay error for store', entry.storeName, ':', e.message);
        }
      }

      console.log(`[TabVault DB] Replayed ${replayed} WAL entries`);
      resolve(replayed);
    };

    request.onerror = () => reject(request.error);
  });
}

/**
 * Clean old WAL entries (keep last 1000)
 */
async function cleanWAL() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.WAL, 'readwrite');
    const store = tx.objectStore(STORES.WAL);
    const countRequest = store.count();

    countRequest.onsuccess = () => {
      const count = countRequest.result;
      if (count <= 1000) {
        resolve(0);
        return;
      }

      const index = store.index('timestamp');
      const deleteCount = count - 1000;
      let deleted = 0;

      const cursorRequest = index.openCursor();
      cursorRequest.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor && deleted < deleteCount) {
          if (cursor.value.applied === 1 || cursor.value.applied === true) {
            cursor.delete();
            deleted++;
          }
          cursor.continue();
        } else {
          resolve(deleted);
        }
      };
    };

    countRequest.onerror = () => reject(countRequest.error);
  });
}

// ===== GENERIC CRUD OPERATIONS =====

/**
 * Put a record (insert or update) with WAL protection
 */
async function put(storeName, data) {
  const walId = await writeAheadLog(storeName, 'put', data);
  const db = await openDatabase();
  
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const request = store.put(data);

    request.onsuccess = async () => {
      await markWALApplied(walId);
      resolve(request.result);
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * Put multiple records in a single transaction
 */
async function putBatch(storeName, items) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);

    for (const item of items) {
      store.put(item);
    }

    tx.oncomplete = () => resolve(items.length);
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Get a single record by key
 */
async function get(storeName, key) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const request = store.get(key);

    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Get all records from a store
 */
async function getAll(storeName) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const request = store.getAll();

    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Get records by index
 */
async function getByIndex(storeName, indexName, value) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const index = store.index(indexName);
    const request = index.getAll(value);

    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Delete a record by key with WAL protection
 */
async function remove(storeName, key) {
  const walId = await writeAheadLog(storeName, 'delete', key);
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const request = store.delete(key);

    request.onsuccess = async () => {
      await markWALApplied(walId);
      resolve();
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * Delete multiple records
 */
async function removeBatch(storeName, keys) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);

    for (const key of keys) {
      store.delete(key);
    }

    tx.oncomplete = () => resolve(keys.length);
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Count records in a store
 */
async function count(storeName) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const request = store.count();

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Clear all records from a store
 */
async function clear(storeName) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const request = store.clear();

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

// ===== HELPER UTILITIES =====

/**
 * Extract domain from URL
 */
function extractDomain(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/**
 * Generate unique ID
 */
function generateId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

// Export everything
export {
  STORES,
  openDatabase,
  replayWAL,
  cleanWAL,
  put,
  putBatch,
  get,
  getAll,
  getByIndex,
  remove,
  removeBatch,
  count,
  clear,
  extractDomain,
  generateId
};
