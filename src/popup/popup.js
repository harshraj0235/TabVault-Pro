/**
 * TabVault Pro — Popup Main Logic
 * Handles UI rendering, search, tab actions, sessions, workspaces.
 */

import { TabSearchEngine } from '../search/search-engine.js';

const search = new TabSearchEngine();
let allTabs = [];
let currentPanel = 'tabs';
let duplicateTabIds = new Set();

// ===== INIT =====
document.addEventListener('DOMContentLoaded', async () => {
  await loadTabs();
  await loadStats();
  setupEventListeners();
  document.getElementById('searchInput').focus();

  const isPro = await sendMsg({ action: 'isPro' });
  if (isPro) document.getElementById('proBadge').style.display = 'inline';
});

// ===== DATA LOADING =====
async function sendMsg(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp) => resolve(resp));
  });
}

async function loadTabs() {
  allTabs = await sendMsg({ action: 'getTabs' }) || [];
  search.updateIndex(allTabs);
  // Get duplicates
  const dupes = await sendMsg({ action: 'findDuplicates' }) || [];
  duplicateTabIds.clear();
  dupes.forEach(d => d.tabs.forEach(t => duplicateTabIds.add(t.id)));
  renderTabs(allTabs);
}

async function loadStats() {
  const stats = await sendMsg({ action: 'getTabStats' }) || {};
  const mem = await sendMsg({ action: 'getMemorySavings' }) || {};
  document.querySelector('#statTabs .stat-num').textContent = stats.totalTabs || 0;
  document.querySelector('#statWindows .stat-num').textContent = stats.totalWindows || 0;
  document.querySelector('#statSaved .stat-num').textContent = mem.estimatedSavingsMB || 0;
}

// ===== TAB RENDERING =====
async function renderTabs(tabs) {
  const list = document.getElementById('tabList');
  const empty = document.getElementById('emptyTabState');
  
  if (!tabs || tabs.length === 0) {
    list.innerHTML = '';
    empty.style.display = 'flex';
    document.getElementById('searchCount').textContent = '';
    return;
  }
  
  empty.style.display = 'none';
  
  const frag = document.createDocumentFragment();
  const elements = await Promise.all(tabs.map(createTabElement));
  elements.forEach(el => frag.appendChild(el));
  
  list.innerHTML = '';
  list.appendChild(frag);
  
  if (document.getElementById('searchInput').value) {
    document.getElementById('searchCount').textContent = `${tabs.length} found`;
  } else {
    document.getElementById('searchCount').textContent = '';
  }
}

async function createTabElement(tab) {
  const el = document.createElement('div');
  el.className = 'tab-item';
  if (tab.active) el.classList.add('active-tab');
  if (tab.discarded) el.classList.add('suspended');
  if (duplicateTabIds.has(tab.id)) el.classList.add('duplicate');
  el.dataset.tabId = tab.id;
  el.dataset.windowId = tab.windowId;
  
  // Drag & Drop
  el.draggable = true;
  el.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', tab.id);
    e.dataTransfer.effectAllowed = 'move';
    document.querySelector('[data-panel="workspaces"]').click(); // Auto-switch to workspaces
  });
  el.addEventListener('dragend', (e) => {
    if (e.dataTransfer.dropEffect === 'none') {
      document.querySelector('[data-panel="tabs"]').click(); // Switch back if cancelled
    }
  });

  // Favicon
  let faviconHtml;
  if (tab.favIconUrl && !tab.favIconUrl.startsWith('chrome://')) {
    faviconHtml = `<img class="tab-favicon" src="${escHtml(tab.favIconUrl)}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><div class="tab-favicon-placeholder" style="display:none">${(tab.title || '?')[0].toUpperCase()}</div>`;
  } else {
    faviconHtml = `<div class="tab-favicon-placeholder">${(tab.title || '?')[0].toUpperCase()}</div>`;
  }

  // Badges
  let badges = '';
  if (tab.pinned) badges += '<span class="badge badge-pinned">PIN</span>';
  if (tab.audible) badges += '<span class="badge badge-audible">♪</span>';
  if (tab.discarded) badges += '<span class="badge badge-suspended">ZZZ</span>';
  if (duplicateTabIds.has(tab.id)) badges += `<span class="badge dup-badge" title="Duplicate">Duplicate</span>`;

  // Use highlighted title if available
  const title = tab._highlightedTitle || escHtml(tab.title || 'Untitled');
  const domain = tab.domain || '';
  
  let thumbnailHtml = '';
  if (isGridView) {
    const thumbData = await sendMsg({ action: 'getThumbnail', url: tab.url });
    if (thumbData && thumbData.dataUrl) {
      thumbnailHtml = `<div class="tab-thumbnail" style="background-image: url('${thumbData.dataUrl}')"></div>`;
    } else {
      thumbnailHtml = `<div class="tab-thumbnail">No preview</div>`;
    }
  }

  el.innerHTML = `
    ${thumbnailHtml}
    <div class="tab-favicon">${faviconHtml}</div>
    <div class="tab-info">
      <div class="tab-title">${title}</div>
      <div class="tab-url">${escHtml(domain)}</div>
    </div>
    <div class="tab-badges">${badges}</div>
    <div class="tab-actions">
      <button class="tab-action-btn" data-action="snooze" title="Snooze">⏰</button>
      <button class="tab-action-btn" data-action="suspend" title="Suspend">💤</button>
      <button class="tab-action-btn" data-action="pin" title="${tab.pinned ? 'Unpin' : 'Pin'}">📌</button>
      <button class="tab-action-btn tab-action-btn close" data-action="close" title="Close">✕</button>
    </div>
  `;

  // Click to switch
  el.addEventListener('click', (e) => {
    if (e.target.closest('.tab-action-btn')) return;
    switchToTab(tab.id, tab.windowId);
  });

  // Action buttons
  el.querySelectorAll('.tab-action-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleTabAction(btn.dataset.action, tab);
    });
  });

  return el;
}

// ===== TAB ACTIONS =====
async function switchToTab(tabId, windowId) {
  await sendMsg({ action: 'switchToTab', tabId, windowId });
  window.close();
}

async function handleTabAction(action, tab) {
  switch (action) {
    case 'snooze':
      const minsStr = window.prompt("Snooze tab for how many minutes?", "60");
      const mins = parseInt(minsStr);
      if (!mins || isNaN(mins) || mins <= 0) return;
      await sendMsg({ action: 'snoozeTab', tabId: tab.id, minutes: mins });
      showToast(`Tab snoozed for ${mins} minutes ⏰`, 'success');
      await loadTabs();
      await loadStats();
      break;
    case 'close':
      await sendMsg({ action: 'closeTab', tabId: tab.id });
      showToast('Tab closed', 'success');
      await loadTabs();
      await loadStats();
      break;
    case 'suspend':
      await sendMsg({ action: 'suspendTab', tabId: tab.id });
      showToast('Tab suspended', 'success');
      await loadTabs();
      await loadStats();
      break;
    case 'pin':
      await sendMsg({ action: 'pinTab', tabId: tab.id, pinned: !tab.pinned });
      await loadTabs();
      break;
  }
}

// ===== SEARCH =====
let searchTimeout;
function handleSearch(query) {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    const clearBtn = document.getElementById('searchClear');
    if (query.trim()) {
      clearBtn.style.display = 'block';
      
      if (query.startsWith('/')) {
        renderCommands(query);
        return;
      }
      
      const results = search.search(query);
      // Add highlighted titles
      results.forEach(r => {
        r._highlightedTitle = search.highlightMatch(r.title || '', query);
      });
      renderTabs(results);
    } else {
      clearBtn.style.display = 'none';
      renderTabs(allTabs);
    }
  }, 80);
}

function renderCommands(query) {
  const commands = [
    { cmd: '/suspend', desc: 'Suspend all inactive tabs', icon: '💤', action: () => document.getElementById('btnSuspendAll').click() },
    { cmd: '/dupes', desc: 'Close duplicate tabs', icon: '🗑️', action: () => document.getElementById('btnCloseDupes').click() },
    { cmd: '/save', desc: 'Save current session', icon: '💾', action: () => document.getElementById('btnSaveSession').click() },
    { cmd: '/settings', desc: 'Open settings', icon: '⚙️', action: () => document.getElementById('btnSettings').click() }
  ];
  
  const filtered = commands.filter(c => c.cmd.includes(query.toLowerCase()));
  const list = document.getElementById('tabList');
  const empty = document.getElementById('emptyTabState');
  empty.style.display = 'none';
  
  const frag = document.createDocumentFragment();
  filtered.forEach(c => {
    const el = document.createElement('div');
    el.className = 'tab-item';
    el.style.cursor = 'pointer';
    el.innerHTML = `
      <div class="tab-favicon-placeholder" style="background:transparent; font-size:16px;">${c.icon}</div>
      <div class="tab-info">
        <div class="tab-title">${c.cmd}</div>
        <div class="tab-url">${c.desc}</div>
      </div>
    `;
    el.addEventListener('click', () => {
       document.getElementById('searchInput').value = '';
       handleSearch('');
       c.action();
    });
    frag.appendChild(el);
  });
  
  list.innerHTML = '';
  list.appendChild(frag);
  document.getElementById('searchCount').textContent = `${filtered.length} cmds`;
}

// ===== SESSIONS =====
async function loadSessions() {
  const sessions = await sendMsg({ action: 'getSessions' }) || [];
  const list = document.getElementById('sessionList');
  const empty = document.getElementById('emptySessionState');
  
  if (sessions.length === 0) {
    list.innerHTML = '';
    empty.style.display = 'flex';
    return;
  }
  
  // Sort descending
  sessions.sort((a, b) => b.createdAt - a.createdAt);
  
  empty.style.display = 'none';
  const frag = document.createDocumentFragment();
  
  let currentDay = '';
  
  sessions.forEach((s, idx) => {
    const d = new Date(s.createdAt);
    const dayStr = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    
    if (dayStr !== currentDay) {
      currentDay = dayStr;
      const dayHeader = document.createElement('div');
      dayHeader.className = 'timeline-day';
      
      const todayStr = new Date().toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
      const yest = new Date(); yest.setDate(yest.getDate() - 1);
      const yestStr = yest.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
      
      if (currentDay === todayStr) dayHeader.textContent = 'Today';
      else if (currentDay === yestStr) dayHeader.textContent = 'Yesterday';
      else dayHeader.textContent = currentDay;
      
      frag.appendChild(dayHeader);
    }
    
    const el = document.createElement('div');
    el.className = 'session-item';
    
    if (idx === 0 || new Date(sessions[idx-1].createdAt).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) !== currentDay) el.classList.add('first-of-day');
    if (idx === sessions.length - 1 || new Date(sessions[idx+1].createdAt).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) !== currentDay) el.classList.add('last-of-day');
    
    const iconClass = s.type === 'auto' ? 'auto' : s.type === 'crash' ? 'crash' : '';
    const iconSvg = s.type === 'crash' ? '🛡️' : s.type === 'auto' ? '⏰' : '💾';
    const timeStr = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    
    el.innerHTML = `
      <div class="session-icon ${iconClass}">${iconSvg}</div>
      <div class="session-info">
        <div class="session-name">${escHtml(s.name)}</div>
        <div class="session-meta">${s.tabCount} tabs · ${timeStr}</div>
      </div>
      <div class="session-actions">
        <button class="tab-action-btn" data-action="restore" title="Restore">↗️</button>
        <button class="tab-action-btn close" data-action="delete" title="Delete">✕</button>
      </div>
    `;
    
    el.querySelector('[data-action="restore"]').addEventListener('click', async () => {
      await sendMsg({ action: 'restoreSession', sessionId: s.id });
      showToast(`Restored "${s.name}"`, 'success');
    });
    
    el.querySelector('[data-action="delete"]').addEventListener('click', async () => {
      await sendMsg({ action: 'deleteSession', sessionId: s.id });
      showToast('Session deleted', 'info');
      loadSessions();
    });
    
    frag.appendChild(el);
  });
  
  list.innerHTML = '';
  list.appendChild(frag);
}

// ===== WORKSPACES =====
async function loadWorkspaces() {
  const workspaces = await sendMsg({ action: 'getWorkspaces' }) || [];
  const list = document.getElementById('workspaceList');
  
  if (workspaces.length === 0) {
    list.innerHTML = '<div class="empty-state"><p>No workspaces yet</p></div>';
    return;
  }
  
  const sessions = await sendMsg({ action: 'getSessions' }) || [];
  const frag = document.createDocumentFragment();
  
  workspaces.forEach(w => {
    const session = sessions.find(s => s.workspaceId === w.id);
    const sessionCount = sessions.filter(s => s.workspaceId === w.id).length;
    const el = document.createElement('div');
    el.className = 'workspace-item';
    
    el.innerHTML = `
      <div class="workspace-color" style="background:${w.color}"></div>
      <div class="workspace-info">
        <div class="workspace-name">${escHtml(w.name)}</div>
        <div class="workspace-count">${session ? session.tabCount : 0} tabs</div>
        <div class="workspace-summary" style="display:none; font-size: 11px; color: var(--text-muted); margin-top: 4px; font-style: italic; line-height: 1.3;"></div>
      </div>
      <div class="workspace-actions">
        <button class="tab-action-btn" data-action="ai" title="AI Summary (Pro)">✨</button>
        <button class="tab-action-btn" data-action="delete" title="Delete Workspace">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </button>
      </div>
    `;
    
    // AI Summarization
    el.querySelector('[data-action="ai"]').addEventListener('click', async (e) => {
      e.stopPropagation();
      const isPro = await sendMsg({ action: 'isPro' });
      if (!isPro) {
        showToast('AI Summarization is a Pro feature! 💎', 'error');
        document.getElementById('btnSettings').click();
        return;
      }
      
      const summaryDiv = el.querySelector('.workspace-summary');
      summaryDiv.style.display = 'block';
      summaryDiv.textContent = 'Thinking... 🤔';
      
      try {
        if (!session || session.tabCount === 0) {
           summaryDiv.textContent = 'No tabs to summarize.';
           return;
        }
        
        let tabText = '';
        for (const winId in session.windows) {
           session.windows[winId].forEach(t => {
              tabText += `- ${t.title} (${t.url})\n`;
           });
        }
        
        // Check for built-in AI API
        const aiApi = window.ai?.languageModel || window.ai;
        if (!aiApi || !aiApi.create) {
            if (navigator.userAgent.includes("Edg/")) {
                summaryDiv.innerHTML = `AI Summarization relies on Chrome's built-in Nano model and is currently unavailable on Edge.`;
            } else {
                summaryDiv.innerHTML = `Please enable <a href="chrome://flags/#prompt-api-for-extension" target="_blank" style="color:var(--accent);text-decoration:underline;">Prompt API</a> in Chrome flags.`;
            }
            return;
        }
        
        const capabilities = await aiApi.capabilities();
        if (capabilities.available === 'no') {
            summaryDiv.textContent = 'AI model not downloaded yet. Check chrome://components.';
            return;
        }
        
        const sessionAi = await aiApi.create();
        const prompt = `Briefly summarize what this collection of web tabs is about in 1-2 short sentences. Focus on the main topic:\n\n${tabText}`;
        
        const result = await sessionAi.prompt(prompt);
        summaryDiv.textContent = result.trim();
        
      } catch(err) {
        summaryDiv.textContent = 'AI Error: ' + err.message;
      }
    });

    el.querySelector('[data-action="delete"]').addEventListener('click', async (e) => {
      e.stopPropagation();
      await sendMsg({ action: 'deleteWorkspace', workspaceId: w.id });
      showToast('Workspace deleted', 'info');
      loadWorkspaces();
    });
    
    // Drag and Drop (Kanban)
    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      el.classList.add('drag-over');
    });
    
    el.addEventListener('dragleave', () => {
      el.classList.remove('drag-over');
    });
    
    el.addEventListener('drop', async (e) => {
      e.preventDefault();
      el.classList.remove('drag-over');
      const tabId = parseInt(e.dataTransfer.getData('text/plain'));
      if (!tabId) return;
      
      await sendMsg({ action: 'saveTabToWorkspace', tabId, workspaceId: w.id });
      await sendMsg({ action: 'closeTab', tabId }); // Close original tab
      showToast('Tab saved to workspace!', 'success');
      
      document.querySelector('[data-panel="tabs"]').click(); // Return to tabs view
      await loadTabs();
      await loadStats();
    });
    
    frag.appendChild(el);
  });
  
  list.innerHTML = '';
  list.appendChild(frag);
}

// ===== EVENT LISTENERS =====
function setupEventListeners() {
  // Search
  const searchInput = document.getElementById('searchInput');
  searchInput.addEventListener('input', (e) => handleSearch(e.target.value));
  
  searchInput.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      const query = searchInput.value.trim();
      if (query.startsWith('?') && query.length > 2) {
        e.preventDefault();
        const semanticQuery = query.substring(1).trim();
        document.getElementById('searchCount').textContent = 'AI Searching... ✨';
        
        const aiResult = await sendMsg({ action: 'semanticSearch', query: semanticQuery });
        if (aiResult.success) {
           const aiTabs = allTabs.filter(t => aiResult.ids.includes(t.id));
           renderTabs(aiTabs);
           document.getElementById('searchCount').textContent = `${aiTabs.length} semantic matches ✨`;
        } else {
           if (aiResult.error === 'No API Key') {
             showToast('Add your Gemini Key in Settings for AI Search!', 'error');
           }
           document.getElementById('searchCount').textContent = 'AI Error';
        }
      }
    }
  });

  document.getElementById('searchClear').addEventListener('click', () => {
    searchInput.value = '';
    handleSearch('');
    searchInput.focus();
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const settings = document.getElementById('settingsOverlay');
      if (settings.style.display !== 'none') {
        settings.style.display = 'none';
      } else {
        document.getElementById('searchInput').value = '';
        handleSearch('');
      }
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault();
      document.getElementById('searchInput').focus();
    }
  });

  // Nav tabs
  document.querySelectorAll('.nav-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-tab').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      const panel = btn.dataset.panel;
      document.getElementById('panel' + panel.charAt(0).toUpperCase() + panel.slice(1)).classList.add('active');
      currentPanel = panel;
      if (panel === 'sessions') loadSessions();
      if (panel === 'workspaces') loadWorkspaces();
    });
  });

  // Header actions
  document.getElementById('btnSuspendAll').addEventListener('click', async () => {
    const result = await sendMsg({ action: 'suspendAll' });
    showToast(`Suspended ${result.suspended} tabs`, 'success');
    await loadTabs();
    await loadStats();
  });

  document.getElementById('btnCloseDupes').addEventListener('click', async () => {
    const result = await sendMsg({ action: 'closeDuplicates' });
    showToast(`Closed ${result.closed} duplicates`, 'success');
    await loadTabs();
    await loadStats();
  });

  let isGridView = false;
  
  document.getElementById('btnGridView').addEventListener('click', () => {
    isGridView = !isGridView;
    const tabList = document.getElementById('tabList');
    if (isGridView) tabList.classList.add('grid-view');
    else tabList.classList.remove('grid-view');
    loadTabs();
  });

  document.getElementById('btnGroupTabs').addEventListener('click', async () => {
    const isPro = await sendMsg({ action: 'isPro' });
    if (!isPro) {
      showToast('Auto-Grouping is a Pro feature! 💎', 'error');
      document.getElementById('btnSettings').click(); 
      return;
    }
    showToast('Grouping tabs...', 'info');
    const result = await sendMsg({ action: 'autoGroupTabs' });
    showToast(`Created ${result.groups} groups!`, 'success');
    await loadTabs();
  });

  // Settings
  document.getElementById('btnSettings').addEventListener('click', async () => {
    document.getElementById('settingsOverlay').style.display = 'block';
    const settings = await sendMsg({ action: 'getSuspenderSettings' });
    if (settings) {
      document.getElementById('settingSuspendEnabled').checked = settings.enabled;
      document.getElementById('settingSuspendMinutes').value = settings.inactiveMinutes;
      document.getElementById('settingNeverPinned').checked = settings.neverSuspendPinned;
      document.getElementById('settingNeverAudible').checked = settings.neverSuspendAudible;
      document.getElementById('settingWhitelist').value = (settings.whitelistDomains || []).join(', ');
      document.getElementById('settingGeminiKey').value = settings.geminiKey || '';
    }
    
    const isPro = await sendMsg({ action: 'isPro' });
    if (isPro) {
      document.getElementById('upgradeCard').style.display = 'none';
      document.getElementById('proActiveCard').style.display = 'block';
    } else {
      document.getElementById('upgradeCard').style.display = 'block';
      document.getElementById('proActiveCard').style.display = 'none';
    }
  });

  document.getElementById('btnCloseSettings').addEventListener('click', async () => {
    const whitelistStr = document.getElementById('settingWhitelist').value || '';
    const whitelistDomains = whitelistStr.split(',').map(s => s.trim()).filter(s => s.length > 0);

    // Save settings
    await sendMsg({
      action: 'updateSuspenderSettings',
      settings: {
        enabled: document.getElementById('settingSuspendEnabled').checked,
        inactiveMinutes: parseInt(document.getElementById('settingSuspendMinutes').value) || 30,
        neverSuspendPinned: document.getElementById('settingNeverPinned').checked,
        neverSuspendAudible: document.getElementById('settingNeverAudible').checked,
        whitelistDomains,
        geminiKey: document.getElementById('settingGeminiKey').value.trim()
      }
    });
    document.getElementById('settingsOverlay').style.display = 'none';
    showToast('Settings saved', 'success');
  });

  // Save session
  document.getElementById('btnSaveSession').addEventListener('click', async () => {
    showNameModal('Save Session', 'Session name...', async (name) => {
      const limits = await sendMsg({ action: 'checkLimits' });
      if (!limits.canCreateSession) {
        showToast(`Session limit reached (${limits.sessionLimit}). Upgrade to Pro!`, 'error');
        return;
      }
      await sendMsg({ action: 'saveSession', name });
      showToast('Session saved!', 'success');
      loadSessions();
    });
  });

  // New workspace
  document.getElementById('btnNewWorkspace').addEventListener('click', async () => {
    showNameModal('New Workspace', 'Workspace name...', async (name) => {
      const limits = await sendMsg({ action: 'checkLimits' });
      if (!limits.canCreateWorkspace) {
        showToast(`Workspace limit reached (${limits.workspaceLimit}). Upgrade to Pro!`, 'error');
        return;
      }
      const colors = ['#6366f1','#22c55e','#f59e0b','#ef4444','#ec4899','#06b6d4','#8b5cf6'];
      const color = colors[Math.floor(Math.random() * colors.length)];
      await sendMsg({ action: 'createWorkspace', name, color });
      showToast('Workspace created!', 'success');
      loadWorkspaces();
    });
  });

  // Data export/import
  document.getElementById('btnHelp').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/popup/onboarding.html') });
  });

  document.getElementById('btnExport').addEventListener('click', async () => {
    try {
      const dataStr = await sendMsg({ action: 'exportData' });
      const blob = new Blob([dataStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `TabVault_Backup_${new Date().toISOString().split('T')[0]}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showToast('Export successful', 'success');
    } catch (e) {
      showToast('Export failed', 'error');
    }
  });

  // Import
  document.getElementById('btnImport').addEventListener('click', () => {
    document.getElementById('importFile').click();
  });

  document.getElementById('importFile').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const result = await sendMsg({ action: 'importData', data: event.target.result });
        if (result && result.error) throw new Error(result.error);
        showToast('Import successful! Please restart extension.', 'success');
      } catch (err) {
        showToast('Import failed: Invalid file', 'error');
      }
    };
    reader.readAsText(file);
    // Reset input so the same file can be selected again
    e.target.value = '';
  });

  // Upgrade
  document.getElementById('btnUpgrade').addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://rzp.io/rzp/y4budv6' });
  });

  // Unlock Keyword
  document.getElementById('btnUnlockPro').addEventListener('click', async () => {
    const key = document.getElementById('licenseInput').value.trim().toUpperCase();
    if (key === 'UNLOCK_PRO' || key === 'TABVAULT_PRO') {
      await sendMsg({ action: 'activatePro' });
      showToast('Pro features unlocked! 🚀', 'success');
      document.getElementById('upgradeCard').style.display = 'none';
      document.getElementById('proActiveCard').style.display = 'block';
      document.getElementById('proBadge').style.display = 'inline';
    } else {
      showToast('Invalid keyword', 'error');
    }
  });
}

// ===== MODAL =====
function showNameModal(title, placeholder, callback) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h3>${title}</h3>
      <input type="text" class="modal-input" placeholder="${placeholder}" autofocus>
      <div class="modal-actions">
        <button class="btn btn-outline modal-cancel">Cancel</button>
        <button class="btn btn-primary modal-confirm">Save</button>
      </div>
    </div>
  `;
  
  document.getElementById('app').appendChild(overlay);
  const input = overlay.querySelector('.modal-input');
  input.focus();
  
  const close = () => overlay.remove();
  
  overlay.querySelector('.modal-cancel').addEventListener('click', close);
  overlay.querySelector('.modal-confirm').addEventListener('click', () => {
    const val = input.value.trim();
    if (val) { callback(val); close(); }
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const val = input.value.trim();
      if (val) { callback(val); close(); }
    }
    if (e.key === 'Escape') close();
  });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
}

// ===== TOAST =====
function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 200); }, 2500);
}

// ===== UTILITIES =====
function escHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function timeAgo(timestamp) {
  const diff = Date.now() - timestamp;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}
