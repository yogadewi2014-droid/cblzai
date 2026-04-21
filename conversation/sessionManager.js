async function getSession(userId) {
    if (redis) {
        const data = await redis.get(`session:${userId}`);
        if (!data) return null;
        try {
            // Jika data sudah berupa object, langsung kembalikan
            if (typeof data === 'object') return data;
            // Jika string, parse JSON
            return JSON.parse(data);
        } catch (e) {
            logger.error('Invalid session JSON, resetting:', e.message);
            await redis.del(`session:${userId}`); // hapus data rusak
            return null;
        }
    }
    // fallback in-memory
    return global.sessionStore?.get(userId) || null;
}
