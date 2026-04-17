/**
 * AEO Stage 1: Semantic Cache
 *
 * A local in-memory dictionary that stores resolved query→response pairs.
 * Uses token-overlap Jaccard similarity (threshold 0.55) to match semantically
 * equivalent queries without requiring an embedding model.
 *
 * On a cache HIT: returns instantly, logs 0 compute time, saves 100% energy.
 * On a cache MISS: passes through to the next AEO stage.
 */

export class SemanticCache {
  constructor() {
    this.store = new Map(); // query_normalized -> { response, hitCount, createdAt }
    this.hits = 0;
    this.misses = 0;
    this.SIMILARITY_THRESHOLD = 0.55;
    // Stopwords to ignore during tokenization
    this.STOPWORDS = new Set([
      'i','a','an','the','is','are','was','were','be','been','being',
      'have','has','had','do','does','did','will','would','could','should',
      'may','might','to','of','in','for','on','with','at','by','from',
      'how','what','when','where','why','who','can','my','me','we','you',
      'it','this','that','these','those'
    ]);
  }

  /**
   * Tokenize query into meaningful content words
   */
  _tokenize(text) {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 2 && !this.STOPWORDS.has(w));
  }

  /**
   * Jaccard similarity between two token sets
   */
  _similarity(tokA, tokB) {
    const setA = new Set(tokA);
    const setB = new Set(tokB);
    let intersection = 0;
    setA.forEach(t => { if (setB.has(t)) intersection++; });
    const union = setA.size + setB.size - intersection;
    return union === 0 ? 0 : intersection / union;
  }

  /**
   * Attempt to retrieve a semantically similar cached response.
   * Returns { hit: true, response, matchedQuery, similarity } or { hit: false }
   */
  get(query) {
    const tokensQ = this._tokenize(query);

    let bestMatch = null;
    let bestSim = 0;

    for (const [key, entry] of this.store) {
      const tokensKey = this._tokenize(key);
      const sim = this._similarity(tokensQ, tokensKey);
      if (sim > bestSim) {
        bestSim = sim;
        bestMatch = { key, entry, similarity: sim };
      }
    }

    if (bestMatch && bestMatch.similarity >= this.SIMILARITY_THRESHOLD) {
      this.hits++;
      bestMatch.entry.hitCount++;
      return {
        hit: true,
        response: bestMatch.entry.response,
        matchedQuery: bestMatch.key,
        similarity: bestMatch.similarity,
        hitCount: bestMatch.entry.hitCount
      };
    }

    this.misses++;
    return { hit: false };
  }

  /**
   * Store a resolved query→response pair
   */
  set(query, response) {
    this.store.set(query, {
      response,
      hitCount: 0,
      createdAt: Date.now()
    });
  }

  getStats() {
    return {
      entries: this.store.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: this.hits + this.misses === 0
        ? 0
        : (this.hits / (this.hits + this.misses) * 100).toFixed(1)
    };
  }

  clear() {
    this.store.clear();
    this.hits = 0;
    this.misses = 0;
  }
}
