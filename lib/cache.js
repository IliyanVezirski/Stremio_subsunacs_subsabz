class BoundedCache {
    constructor(maxEntries, maxBytes = Infinity) {
        this.maxEntries = maxEntries;
        this.maxBytes = maxBytes;
        this.entries = new Map();
        this.bytes = 0;
    }
    delete(key) {
        const entry = this.entries.get(key);
        if (entry) this.bytes -= entry.bytes;
        this.entries.delete(key);
    }
    prune(now = Date.now()) {
        for (const [key, entry] of this.entries) if (entry.expires <= now) this.delete(key);
    }
    get(key) {
        const entry = this.entries.get(key);
        if (!entry) return undefined;
        if (entry.expires <= Date.now()) { this.delete(key); return undefined; }
        this.entries.delete(key);
        this.entries.set(key, entry);
        return entry.value;
    }
    set(key, value, ttl) {
        this.prune();
        this.delete(key);
        const bytes = Buffer.byteLength(JSON.stringify(value));
        if (bytes > this.maxBytes) return;
        this.entries.set(key, { value, bytes, expires: Date.now() + ttl });
        this.bytes += bytes;
        while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) this.delete(this.entries.keys().next().value);
    }
    get size() { this.prune(); return this.entries.size; }
}
module.exports = { BoundedCache };
