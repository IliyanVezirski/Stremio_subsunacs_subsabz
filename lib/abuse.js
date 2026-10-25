const { BoundedCache } = require('./cache');
const ipaddr = require('ipaddr.js');

function normalizeIp(value) {
    try {
        let address = ipaddr.parse(value);
        if (address.kind() === 'ipv6' && address.isIPv4MappedAddress()) address = address.toIPv4Address();
        // A single IPv6 subscriber must not evade limits by rotating interface addresses.
        if (address.kind() === 'ipv6') return address.parts.slice(0, 4).map(n => n.toString(16)).join(':') + '::/64';
        return address.toString();
    } catch { return 'unknown'; }
}

class AbuseGuard {
    constructor({ now = Date.now, banMs = 15 * 60 * 1000, maxEntries = 10000 } = {}) {
        this.now = now;
        this.banMs = banMs;
        this.clients = new BoundedCache(maxEntries, 8 * 1024 * 1024);
        this.denied = 0;
        this.bans = 0;
    }
    consume(ip, kind, limit, windowMs = 60000) {
        const now = this.now();
        const state = this.clients.get(ip) || { buckets: {}, strikes: 0, strikeStart: now, bannedUntil: 0 };
        if (state.bannedUntil > now) {
            this.denied++;
            return { allowed: false, status: 403, retryAfter: Math.ceil((state.bannedUntil - now) / 1000) };
        }
        const bucket = state.buckets[kind] || { tokens: limit, updated: now };
        bucket.tokens = Math.min(limit, bucket.tokens + Math.max(0, now - bucket.updated) * limit / windowMs);
        bucket.updated = now;
        state.buckets[kind] = bucket;
        if (bucket.tokens < 1) {
            if (now - state.strikeStart > 5 * 60000) { state.strikes = 0; state.strikeStart = now; }
            state.strikes++;
            this.denied++;
            if (state.strikes >= 5) {
                state.bannedUntil = now + this.banMs;
                state.strikes = 0;
                this.bans++;
                console.warn(`[Protection] Temporary ban: ${ip} (${kind})`);
            }
            this.clients.set(ip, state, this.banMs + 5 * 60000);
            return { allowed: false, status: state.bannedUntil > now ? 403 : 429,
                retryAfter: state.bannedUntil > now ? Math.ceil(this.banMs / 1000) : Math.ceil((1 - bucket.tokens) * windowMs / limit / 1000) };
        }
        bucket.tokens--;
        this.clients.set(ip, state, this.banMs + 5 * 60000);
        return { allowed: true };
    }
}
module.exports = { AbuseGuard, normalizeIp };
