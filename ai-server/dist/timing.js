"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.nowMs = nowMs;
exports.elapsedMs = elapsedMs;
exports.withTiming = withTiming;
function nowMs() {
    return performance.now();
}
function elapsedMs(startMs) {
    return `${(nowMs() - startMs).toFixed(1)}ms`;
}
async function withTiming(label, fn, meta) {
    const startMs = nowMs();
    const suffix = meta ? ` ${JSON.stringify(meta)}` : '';
    console.log(`[timing] start ${label}${suffix}`);
    try {
        const result = await fn();
        console.log(`[timing] done ${label} elapsed=${elapsedMs(startMs)}`);
        return result;
    }
    catch (error) {
        console.log(`[timing] error ${label} elapsed=${elapsedMs(startMs)}`);
        throw error;
    }
}
