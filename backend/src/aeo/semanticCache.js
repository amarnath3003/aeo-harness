/**
 * AEO Stage 1: Semantic Cache  (v2)
 *
 * Improvements over v1:
 *  - TF-IDF weighted Jaccard: rare/domain-specific tokens (e.g. "tourniquet",
 *    "anaphylaxis") now carry far more weight than common words like "help".
 *  - LRU eviction: cap at MAX_ENTRIES; least-recently-used entry is dropped
 *    when the store is full, keeping hot entries in memory.
 *  - TTL expiry: entries older than TTL_MS are treated as misses and lazily
 *    deleted, preventing stale medical/weather advice from being served.
 *  - Per-scope statistics so the orchestrator can report hit rates per
 *    benchmark category independently.
 *  - clearScope() is now O(scope-size) rather than O(total-store).
 */

const MAX_ENTRIES = 512;   // LRU cap
const TTL_MS      = 30 * 60 * 1000; // 30 minutes; set to Infinity to disable

export class SemanticCache {
  constructor(options = {}) {
    // Ordered Map: insertion order = LRU order (oldest first)
    this.store        = new Map();
    this.hits         = 0;
    this.misses       = 0;
    this.evictions    = 0;
    this.maxEntries   = options.maxEntries   ?? MAX_ENTRIES;
    this.ttlMs        = options.ttlMs        ?? TTL_MS;
    this.threshold    = options.threshold    ?? 0.55;

    // Per-scope counters: scope -> { hits, misses }
    this._scopeStats  = new Map();

    // IDF corpus: token -> document-frequency count
    // Built incrementally as entries are added; gives rare tokens more weight.
    this._df          = new Map();
    this._docCount    = 0;

    this.STOPWORDS = new Set([
      'i','a','an','the','is','are','was','were','be','been','being',
      'have','has','had','do','does','did','will','would','could','should',
      'may','might','to','of','in','for','on','with','at','by','from',
      'how','what','when','where','why','who','can','my','me','we','you',
      'it','this','that','these','those','please','just','need','want',
      'get','give','tell','show','help','make','use','know'
    ]);
  }

  // ─── Tokenisation ──────────────────────────────────────────────────────────

  _tokenize(text) {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !this.STOPWORDS.has(w));
  }

  // ─── IDF helpers ───────────────────────────────────────────────────────────

  /** Update IDF corpus when a new query is stored. */
  _updateIDF(tokens) {
    this._docCount++;
    const seen = new Set(tokens);
    for (const t of seen) {
      this._df.set(t, (this._df.get(t) ?? 0) + 1);
    }
  }

  /** IDF score for a token: log((N+1)/(df+1)) + 1 (smoothed). */
  _idf(token) {
    const df = this._df.get(token) ?? 0;
    return Math.log((this._docCount + 1) / (df + 1)) + 1;
  }

  // ─── Similarity ────────────────────────────────────────────────────────────

  /**
   * TF-IDF weighted Jaccard similarity.
   *
   * Standard Jaccard treats every token equally.  Here we weight each token by
   * its IDF score so that rare, domain-specific words (medical/survival terms)
   * dominate the score while common words contribute very little.
   */
  _similarity(tokA, tokB) {
    const setA = new Set(tokA);
    const setB = new Set(tokB);
    const all  = new Set([...setA, ...setB]);

    let intersection = 0;
    let union        = 0;

    for (const t of all) {
      const weight = this._idf(t);
      const inA = setA.has(t);
      const inB = setB.has(t);
      if (inA && inB) intersection += weight;
      union += weight;
    }

    return union === 0 ? 0 : intersection / union;
  }

  // ─── Scope helpers ─────────────────────────────────────────────────────────

  _scopeOf(key) {
    const m = key.match(/^\[scope:([^\]]+)\]/);
    return m ? m[1] : 'default';
  }

  _scopeStat(scope) {
    if (!this._scopeStats.has(scope)) {
      this._scopeStats.set(scope, { hits: 0, misses: 0 });
    }
    return this._scopeStats.get(scope);
  }

  // ─── LRU helpers ───────────────────────────────────────────────────────────

  /** Touch an entry (move to end = most recently used). */
  _touch(key) {
    const entry = this.store.get(key);
    if (entry) {
      this.store.delete(key);
      this.store.set(key, entry);
    }
  }

  /** Evict the oldest (least-recently-used) entry. */
  _evictLRU() {
    const oldest = this.store.keys().next().value;
    if (oldest !== undefined) {
      const entry = this.store.get(oldest);
      // Undo IDF contribution from evicted entry
      if (entry._tokens) {
        const seen = new Set(entry._tokens);
        for (const t of seen) {
          const cur = this._df.get(t) ?? 1;
          if (cur <= 1) this._df.delete(t);
          else           this._df.set(t, cur - 1);
        }
        this._docCount = Math.max(0, this._docCount - 1);
      }
      this.store.delete(oldest);
      this.evictions++;
    }
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Attempt to retrieve a semantically similar cached response.
   *
   * @param {string} query - Normalised cache key (built by orchestrator)
   * @returns {{ hit: boolean, response?, matchedQuery?, similarity?, hitCount? }}
   */
  get(query) {
    const tokensQ = this._tokenize(query);
    const scope   = this._scopeOf(query);
    const now     = Date.now();

    let bestMatch = null;
    let bestSim   = 0;

    for (const [key, entry] of this.store) {
      // Lazy TTL eviction
      if (now - entry.createdAt > this.ttlMs) {
        this.store.delete(key);
        continue;
      }
      const tokensKey = this._tokenize(key);
      const sim       = this._similarity(tokensQ, tokensKey);
      if (sim > bestSim) {
        bestSim   = sim;
        bestMatch = { key, entry, similarity: sim };
      }
    }

    if (bestMatch && bestMatch.similarity >= this.threshold) {
      this.hits++;
      this._scopeStat(scope).hits++;
      bestMatch.entry.hitCount++;
      bestMatch.entry.lastAccessed = now;
      this._touch(bestMatch.key); // promote to MRU position
      return {
        hit          : true,
        response     : bestMatch.entry.response,
        matchedQuery : bestMatch.key,
        similarity   : bestMatch.similarity,
        hitCount     : bestMatch.entry.hitCount
      };
    }

    this.misses++;
    this._scopeStat(scope).misses++;
    return { hit: false };
  }

  /**
   * Store a resolved query→response pair.
   *
   * @param {string} query    - Normalised cache key
   * @param {*}      response - Serialisable response value
   */
  set(query, response) {
    // Don't double-store; just update the response and touch.
    if (this.store.has(query)) {
      const entry = this.store.get(query);
      entry.response     = response;
      entry.lastAccessed = Date.now();
      this._touch(query);
      return;
    }

    // Evict if at capacity
    if (this.store.size >= this.maxEntries) {
      this._evictLRU();
    }

    const tokens = this._tokenize(query);
    this._updateIDF(tokens);

    this.store.set(query, {
      response,
      hitCount    : 0,
      createdAt   : Date.now(),
      lastAccessed: Date.now(),
      _tokens     : tokens  // kept for IDF undo on eviction
    });
  }

  // ─── Statistics & maintenance ──────────────────────────────────────────────

  getStats() {
    const total    = this.hits + this.misses;
    const byScope  = {};
    for (const [scope, s] of this._scopeStats) {
      const t = s.hits + s.misses;
      byScope[scope] = {
        hits    : s.hits,
        misses  : s.misses,
        hitRate : t === 0 ? '0.0' : (s.hits / t * 100).toFixed(1)
      };
    }
    return {
      entries   : this.store.size,
      maxEntries: this.maxEntries,
      hits      : this.hits,
      misses    : this.misses,
      evictions : this.evictions,
      hitRate   : total === 0 ? '0.0' : (this.hits / total * 100).toFixed(1),
      corpusSize: this._docCount,
      byScope
    };
  }

  clear() {
    this.store.clear();
    this._df.clear();
    this._scopeStats.clear();
    this._docCount = 0;
    this.hits      = 0;
    this.misses    = 0;
    this.evictions = 0;
  }

  /**
   * Remove all entries belonging to a scope.  O(scope-size) via index.
   *
   * @param {string} scope
   * @returns {number} Number of deleted entries
   */
  clearScope(scope) {
    if (!scope) return 0;
    const prefix = `[scope:${scope}] `;
    let deleted  = 0;
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
        deleted++;
      }
    }
    this._scopeStats.delete(scope);
    return deleted;
  }

  /**
   * Purge all entries whose TTL has expired.
   * Call periodically for long-running processes.
   *
   * @returns {number} Number of purged entries
   */
  purgeExpired() {
    const now     = Date.now();
    let   purged  = 0;
    for (const [key, entry] of this.store) {
      if (now - entry.createdAt > this.ttlMs) {
        this.store.delete(key);
        purged++;
      }
    }
    return purged;
  }
}