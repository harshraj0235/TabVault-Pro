/**
 * TabVault Pro — Premium License Manager
 * Feature gating for freemium model.
 * Placeholder for ExtensionPay integration.
 */

const PRO_FEATURES = {
  UNLIMITED_SESSIONS: 'unlimited_sessions',
  UNLIMITED_WORKSPACES: 'unlimited_workspaces',
  CLOUD_SYNC: 'cloud_sync',
  AI_GROUPING: 'ai_grouping',
  ADVANCED_SUSPEND: 'advanced_suspend',
  TAB_ANALYTICS: 'tab_analytics',
  SESSION_HISTORY: 'session_history',
  PRIORITY_SUPPORT: 'priority_support'
};

const FREE_LIMITS = {
  maxSessions: 10,
  maxWorkspaces: 3,
  historyDays: 7
};

let cachedStatus = null;

async function getLicenseStatus() {
  if (cachedStatus && (Date.now() - cachedStatus.checkedAt) < 300000) {
    return cachedStatus;
  }
  try {
    const result = await chrome.storage.local.get('tabvault_license');
    cachedStatus = result.tabvault_license || { isPro: false, checkedAt: Date.now() };
    return cachedStatus;
  } catch (e) {
    return { isPro: false, checkedAt: Date.now() };
  }
}

async function isPro() {
  const status = await getLicenseStatus();
  return status.isPro;
}

function isFeatureAvailable(feature, isPro) {
  if (isPro) return true;
  const freeFeatures = [
    'basic_search', 'basic_sessions', 'basic_workspaces',
    'crash_recovery', 'basic_suspend', 'duplicate_detection',
    'keyboard_shortcuts', 'export_import'
  ];
  return freeFeatures.includes(feature);
}

function getFreeLimits() { return { ...FREE_LIMITS }; }

async function setProStatus(status) {
  cachedStatus = { isPro: status, checkedAt: Date.now() };
  await chrome.storage.local.set({ tabvault_license: cachedStatus });
}

export { PRO_FEATURES, FREE_LIMITS, getLicenseStatus, isPro, isFeatureAvailable, getFreeLimits, setProStatus };
