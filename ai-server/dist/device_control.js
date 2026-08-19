"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerDeviceSession = registerDeviceSession;
exports.startDeviceControlServer = startDeviceControlServer;
const http_1 = __importDefault(require("http"));
const media_js_1 = require("./media.js");
const TOOL_MAP = {
    stackchan_get_status: 'self.robot.get_status',
    stackchan_set_speaker_volume: 'self.robot.set_speaker_volume',
    stackchan_play_test_tone: 'self.audio.play_test_tone',
    stackchan_get_head_angles: 'self.robot.get_head_angles',
    stackchan_set_head_angles: 'self.robot.set_head_angles',
    stackchan_set_led_color: 'self.robot.set_led_color',
    stackchan_power_off: 'self.robot.power_off',
    stackchan_take_photo: 'self.camera.capture_photo',
    stackchan_display_image: 'self.screen.preview_image_url',
    stackchan_capture_screen: 'self.screen.capture_screenshot',
    stackchan_create_reminder: 'self.robot.create_reminder',
    stackchan_get_reminders: 'self.robot.get_reminders',
    stackchan_stop_reminder: 'self.robot.stop_reminder',
};
let activeSession = null;
let serverStarted = false;
function isRecord(value) {
    return typeof value === 'object' && value !== null;
}
function isToolName(value) {
    return typeof value === 'string' && value in TOOL_MAP;
}
function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('error', reject);
        req.on('end', () => {
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
            }
            catch (error) {
                reject(error);
            }
        });
    });
}
function sendJson(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
}
function normalizeFirmwareResult(result) {
    if (typeof result !== 'string')
        return result;
    try {
        return JSON.parse(result);
    }
    catch {
        return result;
    }
}
function clampDurationSeconds(value) {
    const duration = typeof value === 'number' ? value : Number(value ?? 6);
    if (!Number.isFinite(duration))
        return 6;
    return Math.max(1, Math.min(30, Math.round(duration)));
}
function readImageSource(args) {
    const source = args['source'] ?? args['url'] ?? args['path'] ?? args['image'];
    return typeof source === 'string' && source.trim() ? source : null;
}
function clampReminderDurationSeconds(value) {
    const duration = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(duration)) {
        throw new Error('duration_seconds must be a finite number');
    }
    return Math.max(1, Math.min(86400, Math.round(duration)));
}
function readReminderMessage(value) {
    const message = typeof value === 'string' ? value.trim() : '';
    if (!message)
        throw new Error('message is required');
    return message.slice(0, 120);
}
function readReminderRepeat(value) {
    if (typeof value === 'boolean')
        return value;
    if (typeof value === 'string')
        return value.toLowerCase() === 'true';
    return false;
}
function clampSpeakerVolume(value) {
    const volume = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(volume)) {
        throw new Error('volume must be a finite number');
    }
    return Math.max(0, Math.min(100, Math.round(volume)));
}
function clampToneFrequency(value) {
    const frequency = typeof value === 'number' ? value : Number(value ?? 440);
    if (!Number.isFinite(frequency)) {
        throw new Error('frequency_hz must be a finite number');
    }
    return Math.max(100, Math.min(2000, Math.round(frequency)));
}
function clampToneDurationMs(value) {
    const duration = typeof value === 'number' ? value : Number(value ?? 800);
    if (!Number.isFinite(duration)) {
        throw new Error('duration_ms must be a finite number');
    }
    return Math.max(100, Math.min(3000, Math.round(duration)));
}
function clampToneAmplitude(value) {
    const amplitude = typeof value === 'number' ? value : Number(value ?? 6000);
    if (!Number.isFinite(amplitude)) {
        throw new Error('amplitude must be a finite number');
    }
    return Math.max(500, Math.min(16000, Math.round(amplitude)));
}
function readReminderId(value) {
    const id = typeof value === 'number' ? value : Number(value);
    if (!Number.isInteger(id) || id < 0) {
        throw new Error('id must be a non-negative integer');
    }
    return id;
}
function readFollowupPrompt(body) {
    const prompt = body['prompt'];
    if (typeof prompt !== 'string' || !prompt.trim()) {
        throw new Error('prompt is required');
    }
    return prompt.trim().slice(0, 12000);
}
async function enqueueFollowupPrompt(prompt) {
    if (!activeSession) {
        throw new Error('No StackChan device is connected');
    }
    await activeSession.enqueueFollowup(prompt);
}
async function callStackChanTool(name, args) {
    if (!activeSession) {
        throw new Error('No StackChan device is connected');
    }
    if (name === 'stackchan_display_image') {
        const source = readImageSource(args);
        if (!source)
            throw new Error('stackchan_display_image requires source, url, path, or image');
        const url = (0, media_js_1.resolveDisplayImageSource)(source);
        if (!url)
            throw new Error(`Unsupported image source for StackChan display: ${source}`);
        return await activeSession.callRobotTool(TOOL_MAP[name], {
            url,
            duration_seconds: clampDurationSeconds(args['duration_seconds']),
        });
    }
    if (name === 'stackchan_create_reminder') {
        return await activeSession.callRobotTool(TOOL_MAP[name], {
            duration_seconds: clampReminderDurationSeconds(args['duration_seconds']),
            message: readReminderMessage(args['message']),
            repeat: readReminderRepeat(args['repeat']),
        });
    }
    if (name === 'stackchan_set_speaker_volume') {
        return await activeSession.callRobotTool(TOOL_MAP[name], {
            volume: clampSpeakerVolume(args['volume']),
            permanent: readReminderRepeat(args['permanent']),
        });
    }
    if (name === 'stackchan_play_test_tone') {
        return await activeSession.callRobotTool(TOOL_MAP[name], {
            frequency_hz: clampToneFrequency(args['frequency_hz']),
            duration_ms: clampToneDurationMs(args['duration_ms']),
            amplitude: clampToneAmplitude(args['amplitude']),
        });
    }
    if (name === 'stackchan_stop_reminder') {
        return await activeSession.callRobotTool(TOOL_MAP[name], {
            id: readReminderId(args['id']),
        });
    }
    return await activeSession.callRobotTool(TOOL_MAP[name], args);
}
function registerDeviceSession(session) {
    activeSession = session;
    return () => {
        if (activeSession === session)
            activeSession = null;
    };
}
function startDeviceControlServer(port, host = '127.0.0.1') {
    if (serverStarted)
        return;
    serverStarted = true;
    const server = http_1.default.createServer(async (req, res) => {
        const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
        if (req.method === 'GET' && pathname === '/internal/status') {
            sendJson(res, 200, {
                success: true,
                result: activeSession?.getBridgeStatus() ?? {
                    connected: false,
                    readyForPrompt: false,
                    reason: 'no_device_session',
                },
            });
            return;
        }
        if (req.method !== 'POST' || (pathname !== '/tools/call' && pathname !== '/internal/followup')) {
            sendJson(res, 404, { success: false, error: 'not found' });
            return;
        }
        try {
            const body = await readBody(req);
            if (!isRecord(body)) {
                sendJson(res, 400, { success: false, error: 'request body must be an object' });
                return;
            }
            if (!activeSession) {
                sendJson(res, 503, { success: false, error: 'No StackChan device is connected' });
                return;
            }
            if (pathname === '/internal/followup') {
                await enqueueFollowupPrompt(readFollowupPrompt(body));
                sendJson(res, 202, { success: true, result: { queued: true } });
                return;
            }
            if (!isToolName(body['name'])) {
                sendJson(res, 400, { success: false, error: 'unknown StackChan tool' });
                return;
            }
            const args = isRecord(body['args']) ? body['args'] : {};
            const result = normalizeFirmwareResult(await callStackChanTool(body['name'], args));
            sendJson(res, 200, { success: true, result });
        }
        catch (error) {
            sendJson(res, 500, {
                success: false,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    });
    server.listen(port, host, () => {
        console.log(`[control] StackChan robot control listening on http://${host}:${port}`);
    });
}
