"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.readLocalTtsOutputConfig = readLocalTtsOutputConfig;
exports.findPipeWireSinkId = findPipeWireSinkId;
exports.resolveLocalTtsOutputTarget = resolveLocalTtsOutputTarget;
exports.playWavOnLocalTarget = playWavOnLocalTarget;
const child_process_1 = require("child_process");
function readLocalTtsOutputConfig(env = process.env) {
    const volume = Number(env['STACKCHAN_LOCAL_TTS_OUTPUT_VOLUME'] ?? '0.35');
    const fallbackM5Volume = Number(env['STACKCHAN_LOCAL_TTS_FALLBACK_M5_VOLUME'] ?? '62');
    return {
        enabled: /^(1|true|yes|on)$/i.test(env['STACKCHAN_LOCAL_TTS_OUTPUT_ENABLED']?.trim() ?? ''),
        targetName: env['STACKCHAN_LOCAL_TTS_OUTPUT_TARGET_NAME']?.trim() || 'JBL Flip 3',
        volume: Number.isFinite(volume) ? Math.max(0, Math.min(1.2, volume)) : 0.35,
        fallbackM5Volume: Number.isFinite(fallbackM5Volume)
            ? Math.max(0, Math.min(100, Math.round(fallbackM5Volume)))
            : 62,
    };
}
function findPipeWireSinkId(status, targetName) {
    const needle = targetName.trim().toLowerCase();
    if (!needle)
        return null;
    let inAudio = false;
    let inSinks = false;
    for (const line of status.split(/\r?\n/)) {
        if (/^Audio\s*$/.test(line)) {
            inAudio = true;
            inSinks = false;
            continue;
        }
        if (/^(Video|Settings)\s*$/.test(line)) {
            inAudio = false;
            inSinks = false;
            continue;
        }
        if (!inAudio)
            continue;
        if (/^\s*├─ Sinks:/.test(line)) {
            inSinks = true;
            continue;
        }
        if (inSinks && /^\s*├─ /.test(line))
            inSinks = false;
        if (!inSinks)
            continue;
        const match = line.match(/^\D*(\d+)\.\s+(.+?)(?:\s+\[|$)/);
        if (!match)
            continue;
        if (match[1] === targetName || match[2].trim().toLowerCase().includes(needle))
            return match[1];
    }
    return null;
}
function execFileText(command, args, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
        (0, child_process_1.execFile)(command, args, { timeout: timeoutMs, encoding: 'utf8' }, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(`${command} failed: ${(stderr || error.message).trim()}`));
                return;
            }
            resolve(stdout);
        });
    });
}
async function resolveLocalTtsOutputTarget(config) {
    if (!config.enabled)
        return null;
    const status = await execFileText('wpctl', ['status']);
    const target = findPipeWireSinkId(status, config.targetName);
    if (!target)
        return null;
    await execFileText('wpctl', ['set-volume', target, config.volume.toFixed(2)]);
    await execFileText('wpctl', ['set-mute', target, '0']);
    return target;
}
function playWavOnLocalTarget(target, wav) {
    return new Promise((resolve, reject) => {
        const child = (0, child_process_1.spawn)('pw-play', ['--target', target, '-'], {
            stdio: ['pipe', 'ignore', 'pipe'],
        });
        const stderr = [];
        child.stderr.on('data', (chunk) => stderr.push(chunk));
        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0) {
                resolve();
                return;
            }
            reject(new Error(`pw-play exited with code ${code}: ${Buffer.concat(stderr).toString('utf8').trim()}`));
        });
        child.stdin.on('error', (error) => {
            if (error.code !== 'EPIPE')
                reject(error);
        });
        child.stdin.end(wav);
    });
}
