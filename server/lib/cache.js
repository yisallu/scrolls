// TTL cache + single-flight, the two things that make a scraper feel fast.
//
// * TtlCache — bounded, insertion-ordered (Map) so eviction is O(1) LRU-ish: a hit
//   re-inserts the key, so the oldest entry is always the first one in the Map.
// * `cached()` also DEDUPES concurrent misses: ten browsers asking for page 1 of the
//   same category at once produce ONE upstream fetch, not ten. Without this, an
//   infinite-scroll grid with a cold cache stampedes the upstream site.

export class TtlCache {
  constructor({ max = 500, ttl = 60_000 } = {}) {
    this.max = max;
    this.ttl = ttl;
    this.map = new Map();
    this.inflight = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  get(key) {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (Date.now() > e.expires) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key); // re-insert → most-recently-used moves to the end
    this.map.set(key, e);
    return e.value;
  }

  set(key, value, ttl = this.ttl) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expires: Date.now() + ttl });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
    return value;
  }

  delete(key) {
    this.map.delete(key);
  }

  /** Drop every entry whose key starts with `prefix` (e.g. all pages of one site). */
  invalidatePrefix(prefix) {
    for (const k of [...this.map.keys()]) if (k.startsWith(prefix)) this.map.delete(k);
  }

  clear() {
    this.map.clear();
  }

  get size() {
    return this.map.size;
  }

  stats() {
    return { size: this.map.size, max: this.max, hits: this.hits, misses: this.misses };
  }

  /**
   * Cache-aside with request coalescing.
   * @param {string} key
   * @param {() => Promise<any>} producer
   * @param {{ ttl?: number, enabled?: boolean }} [opts]
   */
  async cached(key, producer, opts = {}) {
    if (opts.enabled === false) return producer();
    const hit = this.get(key);
    if (hit !== undefined) {
      this.hits++;
      return hit;
    }
    const pending = this.inflight.get(key);
    if (pending) return pending; // someone else is already fetching this exact thing
    this.misses++;
    const p = (async () => producer())()
      .then((value) => {
        this.set(key, value, opts.ttl);
        return value;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }
}

export default TtlCache;
