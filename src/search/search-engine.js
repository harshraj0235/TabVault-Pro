/**
 * TabVault Pro — Search Engine
 * Lightweight fuzzy search using custom implementation (no external deps).
 * Weighted search: title > domain > URL
 */

class TabSearchEngine {
  constructor() {
    this.items = [];
  }

  updateIndex(tabs) {
    this.items = tabs.map(tab => ({
      ...tab,
      _searchTitle: (tab.title || '').toLowerCase(),
      _searchUrl: (tab.url || '').toLowerCase(),
      _searchDomain: (tab.domain || '').toLowerCase()
    }));
  }

  search(query, options = {}) {
    if (!query || query.trim() === '') return this.items;
    const { maxResults = 50, includesSaved = false } = options;
    const q = query.toLowerCase().trim();
    const terms = q.split(/\s+/);
    const scored = [];

    for (const item of this.items) {
      let score = 0;
      let allTermsMatch = true;

      for (const term of terms) {
        let termScore = 0;
        // Exact title match (highest weight)
        if (item._searchTitle.includes(term)) {
          termScore += 100;
          if (item._searchTitle.startsWith(term)) termScore += 50;
        }
        // Domain match
        if (item._searchDomain.includes(term)) {
          termScore += 60;
          if (item._searchDomain.startsWith(term)) termScore += 30;
        }
        // URL match
        if (item._searchUrl.includes(term)) {
          termScore += 30;
        }
        // Fuzzy match on title
        if (termScore === 0) {
          const fuzzyScore = this._fuzzyMatch(term, item._searchTitle);
          if (fuzzyScore > 0) termScore += fuzzyScore * 20;
          else allTermsMatch = false;
        }
        score += termScore;
      }

      // Boost active tabs
      if (item.active) score += 20;
      // Boost pinned tabs
      if (item.pinned) score += 10;
      // Slight boost for recently accessed
      if (item.lastAccessed) {
        const recency = Math.max(0, 1 - (Date.now() - item.lastAccessed) / (24 * 60 * 60 * 1000));
        score += recency * 15;
      }

      if (score > 0 && allTermsMatch) {
        scored.push({ ...item, _score: score });
      }
    }

    scored.sort((a, b) => b._score - a._score);
    return scored.slice(0, maxResults);
  }

  _fuzzyMatch(pattern, text) {
    if (pattern.length > text.length) return 0;
    let pi = 0, score = 0, consecutive = 0;
    for (let ti = 0; ti < text.length && pi < pattern.length; ti++) {
      if (text[ti] === pattern[pi]) {
        pi++;
        consecutive++;
        score += consecutive;
      } else {
        consecutive = 0;
      }
    }
    return pi === pattern.length ? score / pattern.length : 0;
  }

  highlightMatch(text, query) {
    if (!query || !text) return text;
    const terms = query.toLowerCase().split(/\s+/);
    let result = text;
    for (const term of terms) {
      const idx = result.toLowerCase().indexOf(term);
      if (idx >= 0) {
        result = result.slice(0, idx) + '«' + result.slice(idx, idx + term.length) + '»' + result.slice(idx + term.length);
      }
    }
    return result.replace(/«/g, '<mark>').replace(/»/g, '</mark>');
  }
}

export { TabSearchEngine };
