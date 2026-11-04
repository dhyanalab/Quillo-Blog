// In-memory cache of rendered public pages. Cleared on every content change and when a
// scheduled post goes live; entries also expire so "latest"/"popular" lists stay fresh.
// Bounded by entry count and by bytes. The key is the path only: no cached page reads the query string
// (page numbers are in the path), so ?x=1, ?x=2... can't force fresh renders or fill the cache.
// An entry can carry tags (for example "post:12" or "lists"), so one change drops only the pages it touches.
const keyOf = (key) => String(key).split(/[?#]/, 1)[0];
const sizeOf = (key, value) => key.length * 2 + (typeof value?.body === "string" ? Buffer.byteLength(value.body) : 256);

export function createPageCache({ max = 500, ttlMs = 5 * 60_000, maxBytes = 64 * 1024 * 1024 } = {}) {
  const map = new Map();
  const tagged = new Map(); // tag -> Set of keys
  let bytes = 0;
  const drop = (k) => {
    const hit = map.get(k);
    if (hit) {
      bytes -= hit.size;
      for (const tag of hit.tags) {
        const keys = tagged.get(tag);
        keys?.delete(k);
        if (keys && !keys.size) tagged.delete(tag);
      }
    }
    map.delete(k);
  };
  return {
    get(rawKey) {
      const key = keyOf(rawKey);
      const hit = map.get(key);
      if (!hit) return null;
      if (Date.now() > hit.expires) {
        drop(key);
        return null;
      }
      map.delete(key);
      map.set(key, hit); // keep recently used entries at the end
      return hit.value;
    },
    set(rawKey, value, { tags = [] } = {}) {
      const key = keyOf(rawKey);
      const size = sizeOf(key, value);
      drop(key);
      if (size > maxBytes / 4) return; // one huge page never pushes out everything else
      while (map.size >= max || bytes + size > maxBytes) drop(map.keys().next().value);
      const own = [...new Set((Array.isArray(tags) ? tags : [tags]).map(String))];
      map.set(key, { value, size, expires: Date.now() + ttlMs, tags: own });
      for (const tag of own) {
        if (!tagged.has(tag)) tagged.set(tag, new Set());
        tagged.get(tag).add(key);
      }
      bytes += size;
    },
    // Drops every page carrying this tag.
    clearTag(tag) {
      for (const key of [...(tagged.get(String(tag)) || [])]) drop(key);
    },
    clear() {
      map.clear();
      tagged.clear();
      bytes = 0;
    },
    get size() {
      return map.size;
    },
    get bytes() {
      return bytes;
    },
  };
}
