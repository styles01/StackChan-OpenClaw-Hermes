"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const server_js_1 = require("./server.js");
const device_control_js_1 = require("./device_control.js");
const hermes_js_1 = require("./hermes.js");
const PORT = Number(process.env.PORT ?? '8765');
const CONTROL_PORT = Number(process.env.STACKCHAN_CONTROL_PORT ?? '8766');
const CONTROL_HOST = process.env.STACKCHAN_CONTROL_HOST ?? '127.0.0.1';
function isEnabled(value) {
    return value !== undefined && /^(1|true|yes|on)$/i.test(value.trim());
}
async function warmHermes() {
    if (!isEnabled(process.env.STACKCHAN_HERMES_WARMUP_ENABLED))
        return;
    const configuredTimeout = Number(process.env.STACKCHAN_HERMES_WARMUP_TIMEOUT_MS ?? 20_000);
    const timeoutMs = Number.isFinite(configuredTimeout)
        ? Math.max(3_000, Math.min(60_000, Math.round(configuredTimeout)))
        : 20_000;
    const previousTurnTimeout = process.env.HERMES_TURN_TIMEOUT_MS;
    process.env.HERMES_TURN_TIMEOUT_MS = String(timeoutMs);
    const startedAt = performance.now();
    const client = new hermes_js_1.HermesClient();
    try {
        const reply = await client.submitPrompt('日本語で準備完了とだけ答えてください。');
        console.log(`[warmup] Hermes ready elapsed=${Math.round(performance.now() - startedAt)}ms chars=${reply.length}`);
    }
    catch (error) {
        console.warn(`[warmup] Hermes warmup skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
    finally {
        await client.dispose().catch(() => undefined);
        if (previousTurnTimeout === undefined)
            delete process.env.HERMES_TURN_TIMEOUT_MS;
        else
            process.env.HERMES_TURN_TIMEOUT_MS = previousTurnTimeout;
    }
}
async function main() {
    (0, device_control_js_1.startDeviceControlServer)(CONTROL_PORT, CONTROL_HOST);
    await warmHermes();
    (0, server_js_1.startServer)(PORT);
}
void main().catch((error) => {
    console.error(`[server] startup failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exitCode = 1;
});
