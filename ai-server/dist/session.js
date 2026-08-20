"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Session = void 0;
exports.readEnvInt = readEnvInt;
exports.readEnvFloat = readEnvFloat;
exports.readEnvBool = readEnvBool;
exports.readTurnControlConfig = readTurnControlConfig;
exports.readBargeInConfig = readBargeInConfig;
exports.readSpeechSegmentationConfig = readSpeechSegmentationConfig;
exports.readAutoLedConfig = readAutoLedConfig;
exports.inferStackChanEmotion = inferStackChanEmotion;
exports.limitStackChanSpeechText = limitStackChanSpeechText;
exports.splitStackChanSpeechText = splitStackChanSpeechText;
exports.isIgnorableShortTranscript = isIgnorableShortTranscript;
exports.isIgnorableTimeoutTranscript = isIgnorableTimeoutTranscript;
const crypto_1 = require("crypto");
const audio_js_1 = require("./audio.js");
const hermes_js_1 = require("./hermes.js");
const openclaw_js_1 = require("./openclaw.js");
const hermes_audio_js_1 = require("./hermes_audio.js");
const device_control_js_1 = require("./device_control.js");
const media_js_1 = require("./media.js");
const timing_js_1 = require("./timing.js");
const local_vad_js_1 = require("./local_vad.js");
const local_audio_output_js_1 = require("./local_audio_output.js");
function readEnvInt(name, fallback, min, max, env = process.env) {
    const raw = env[name];
    if (!raw)
        return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value))
        return fallback;
    return Math.max(min, Math.min(max, Math.round(value)));
}
function readEnvFloat(name, fallback, min, max, env = process.env) {
    const raw = env[name];
    if (!raw)
        return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value))
        return fallback;
    return Math.max(min, Math.min(max, value));
}
function readEnvBool(name, fallback, env = process.env) {
    const raw = env[name];
    if (!raw)
        return fallback;
    return /^(1|true|yes|on)$/i.test(raw.trim());
}
function readTurnControlConfig(env = process.env) {
    return {
        silenceTimeoutMs: readEnvInt('STACKCHAN_SILENCE_TIMEOUT_MS', 1200, 300, 5000, env),
        maxRecordingMs: readEnvInt('STACKCHAN_MAX_RECORDING_MS', 15000, 3000, 60000, env),
        minFramesForStt: readEnvInt('STACKCHAN_MIN_FRAMES_FOR_STT', 10, 1, 100, env),
        postTtsCooldownMs: readEnvInt('STACKCHAN_POST_TTS_COOLDOWN_MS', 1500, 0, 10000, env),
    };
}
function readBargeInConfig(env = process.env) {
    return {
        enabled: readEnvBool('STACKCHAN_BARGE_IN_ENABLED', false, env),
        rmsThreshold: readEnvFloat('STACKCHAN_BARGE_IN_RMS_THRESHOLD', 0.03, 0.005, 1.0, env),
        startSpeechMs: readEnvInt('STACKCHAN_BARGE_IN_START_SPEECH_MS', 180, audio_js_1.INPUT_FRAME_DURATION_MS, 2000, env),
        minSpeechMs: readEnvInt('STACKCHAN_BARGE_IN_MIN_SPEECH_MS', 180, audio_js_1.INPUT_FRAME_DURATION_MS, 3000, env),
        ignoreTtsStartMs: readEnvInt('STACKCHAN_BARGE_IN_IGNORE_TTS_START_MS', 300, 0, 5000, env),
    };
}
function readSpeechSegmentationConfig(env = process.env) {
    return {
        maxSpeechChars: readEnvInt('STACKCHAN_MAX_SPEECH_CHARS', 800, 8, 4000, env),
        segmentMaxChars: readEnvInt('STACKCHAN_TTS_SEGMENT_MAX_CHARS', 160, 8, 800, env),
        maxSegments: readEnvInt('STACKCHAN_TTS_MAX_SEGMENTS', 8, 1, 32, env),
    };
}
function readAutoLedConfig(env = process.env) {
    return {
        enabled: readEnvBool('STACKCHAN_AUTO_LED_ENABLED', true, env),
        manualHoldMs: readEnvInt('STACKCHAN_AUTO_LED_MANUAL_HOLD_MS', 8000, 0, 60000, env),
    };
}
function inferStackChanEmotion(text) {
    const normalized = (0, media_js_1.stripMediaForSpeech)(text).toLowerCase();
    if (/笑|www|haha|lol/.test(normalized))
        return 'laughing';
    if (/ありがとう|嬉しい|うれしい|よかった|できた|楽しい|いいね|great|nice|happy/.test(normalized))
        return 'happy';
    if (/ごめん|すみません|残念|悲しい|申し訳|sorry/.test(normalized))
        return 'sad';
    if (/眠い|おやすみ|sleepy|good night/.test(normalized))
        return 'sleepy';
    if (/うーん|確認|わからない|分からない|不明|たぶん|maybe|not sure/.test(normalized))
        return 'doubtful';
    return 'neutral';
}
function limitStackChanSpeechText(text, maxChars = MAX_SPEECH_TEXT_CHARS) {
    const stripped = (0, media_js_1.stripMediaForSpeech)(text).replace(/\s+/g, ' ').trim();
    if (stripped.length <= maxChars)
        return stripped;
    return `${stripped.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}
function normalizeSpeechText(text) {
    return text
        .replace(/\r\n?/g, '\n')
        .replace(/[ \t\f\v]+/g, ' ')
        .replace(/ *\n+ */g, '\n')
        .trim();
}
function splitLongSegment(segment, maxChars) {
    if (segment.length <= maxChars)
        return [segment];
    const chunks = [];
    let rest = segment;
    while (rest.length > maxChars) {
        let splitAt = -1;
        const window = rest.slice(0, maxChars + 1);
        for (const marker of ['、', '，', ',', ' ']) {
            const idx = window.lastIndexOf(marker);
            if (idx > Math.floor(maxChars * 0.45)) {
                splitAt = idx + 1;
                break;
            }
        }
        if (splitAt <= 0)
            splitAt = maxChars;
        chunks.push(rest.slice(0, splitAt).trim());
        rest = rest.slice(splitAt).trim();
    }
    if (rest)
        chunks.push(rest);
    return chunks.filter(Boolean);
}
function splitStackChanSpeechText(text, config = SPEECH_SEGMENTATION_CONFIG, fallback = '画像を表示しました。') {
    let speech = normalizeSpeechText((0, media_js_1.stripMediaForSpeech)(text));
    if (!speech)
        speech = fallback;
    if (speech.length > config.maxSpeechChars) {
        speech = `${speech.slice(0, Math.max(1, config.maxSpeechChars - 1)).trimEnd()}…`;
    }
    const rawSegments = [];
    let current = '';
    for (let i = 0; i < speech.length; i++) {
        const ch = speech[i];
        if (ch === '\n') {
            if (current.trim())
                rawSegments.push(current.trim());
            current = '';
            continue;
        }
        current += ch;
        const prev = i > 0 ? speech[i - 1] : '';
        const next = i + 1 < speech.length ? speech[i + 1] : '';
        const isSentenceEnd = /[。！？!?]/.test(ch) ||
            (ch === '.' && !/\d/.test(prev) && !/\d/.test(next));
        if (isSentenceEnd) {
            if (current.trim())
                rawSegments.push(current.trim());
            current = '';
        }
    }
    if (current.trim())
        rawSegments.push(current.trim());
    const segments = rawSegments.flatMap(segment => splitLongSegment(segment, config.segmentMaxChars));
    return segments.filter(Boolean).slice(0, config.maxSegments);
}
function stableSpeechSegmentsFromPartialReply(text, config = SPEECH_SEGMENTATION_CONFIG) {
    const speech = normalizeSpeechText((0, media_js_1.stripMediaForSpeech)(text));
    if (!speech)
        return [];
    const segments = splitStackChanSpeechText(text, config, '');
    if (segments.length === 0)
        return [];
    if (/[。！？!?\n]$/.test(speech))
        return segments;
    return segments.slice(0, -1);
}
// auto モード: フレームが途切れてから処理開始するまでの無音判定時間 (ms)
const TURN_CONTROL_CONFIG = readTurnControlConfig();
const SILENCE_TIMEOUT_MS = TURN_CONTROL_CONFIG.silenceTimeoutMs;
// 最長録音時間 (ms) — 無音検知がなくても強制処理
const MAX_RECORDING_MS = TURN_CONTROL_CONFIG.maxRecordingMs;
// STT を呼ぶ最低フレーム数 (10フレーム × 60ms = 600ms 未満は無音とみなす)
const MIN_FRAMES_FOR_STT = TURN_CONTROL_CONFIG.minFramesForStt;
// TTS 再生後、次の listen start を受け付けるまでのクールダウン (ms) — エコー誤検知防止
const POST_TTS_COOLDOWN_MS = TURN_CONTROL_CONFIG.postTtsCooldownMs;
const BARGE_IN_CONFIG = readBargeInConfig();
const SPEECH_SEGMENTATION_CONFIG = readSpeechSegmentationConfig();
const AUTO_LED_CONFIG = readAutoLedConfig();
const MAX_SPEECH_TEXT_CHARS = SPEECH_SEGMENTATION_CONFIG.maxSpeechChars;
const MCP_REQUEST_TIMEOUT_MS = 10_000;
const PROCESSING_KEEPALIVE_MS = 10_000;
const PROCESS_ERROR_SPEECH = '返答処理でエラーが起きました。設定とサーバーログを確認してください。';
const PROCESS_ERROR_ALERT_MAX_CHARS = 120;
const AUTO_RESUME_LISTENING = readEnvBool('STACKCHAN_AUTO_RESUME_LISTENING', true);
const IGNORE_SHORT_TRANSCRIPTS = readEnvBool('STACKCHAN_IGNORE_SHORT_TRANSCRIPTS', true);
const TTS_PREROLL_MS = readEnvInt('STACKCHAN_TTS_PREROLL_MS', 0, 0, 600);
const FAST_ACK_ENABLED = readEnvBool('STACKCHAN_FAST_ACK_ENABLED', false);
const FAST_ACK_TEXT = (process.env.STACKCHAN_FAST_ACK_TEXT ?? 'はい。').trim() || 'はい。';
const FAST_ACK_TEXTS = readFastAckTexts();
const STOP_LLM_AFTER_MAX_SPOKEN_SEGMENTS = readEnvBool('STACKCHAN_STOP_LLM_AFTER_MAX_SPOKEN_SEGMENTS', true);
const MAX_DURATION_STT_RMS_THRESHOLD = readEnvFloat('STACKCHAN_MAX_DURATION_STT_RMS_THRESHOLD', 0.006, 0, 0.2);
const STREAMING_DECODE_FAILURE_LIMIT = readEnvInt('STACKCHAN_STREAMING_DECODE_FAILURE_LIMIT', 3, 1, 20);
const BARGE_IN_DECODE_FAILURE_LIMIT = readEnvInt('STACKCHAN_BARGE_IN_DECODE_FAILURE_LIMIT', 3, 1, 20);
const DEFAULT_IGNORED_SHORT_TRANSCRIPTS = new Set([
    'あ', 'あっ', 'あー',
    'え', 'えっ', 'えー',
    'お', 'おっ',
    'はい', 'うん', 'ん',
    '了解', 'なるほど', 'わかった', 'OK', 'オーケー',
    'はは', 'ハハ', 'ふふ', 'フフ',
    'ちっ', 'チッ', 'ふっ', 'フッ', 'くっ', 'クッ',
]);
const DEFAULT_IGNORED_TIMEOUT_TRANSCRIPTS = new Set(['あ', 'あっ', 'あー', 'え', 'えっ', 'えー', 'お', 'おっ', 'うん', 'ん', 'はい', 'はは', 'ハハ', 'ふふ', 'フフ', 'ちっ', 'チッ', 'ふっ', 'フッ', 'くっ', 'クッ']);
function readFastAckTexts() {
    const raw = process.env.STACKCHAN_FAST_ACK_TEXTS?.trim();
    const values = raw
        ? raw.split(/[|\n]/g).map(item => item.trim()).filter(Boolean)
        : [FAST_ACK_TEXT];
    return [...new Set(values)].slice(0, 16);
}
function stackChanVoicePrompt(prompt) {
    const prefix = process.env.STACKCHAN_REPLY_PROMPT_PREFIX?.trim();
    if (!prefix)
        return prompt;
    return `${prefix}\nユーザー: ${prompt}`;
}
function normalizedShortTranscript(text) {
    return text
        .normalize('NFKC')
        .trim()
        .replace(/[、。！？!?\s]/g, '')
        .replace(/[ー〜~]+$/g, 'ー');
}
function isIgnorableShortTranscript(text) {
    if (!IGNORE_SHORT_TRANSCRIPTS)
        return false;
    const normalized = normalizedShortTranscript(text);
    if (!normalized)
        return false;
    const configured = process.env.STACKCHAN_IGNORED_SHORT_TRANSCRIPTS;
    const ignored = configured
        ? new Set(configured.split(',').map(item => normalizedShortTranscript(item)).filter(Boolean))
        : DEFAULT_IGNORED_SHORT_TRANSCRIPTS;
    return ignored.has(normalized);
}
function isIgnorableTimeoutTranscript(text) {
    if (!IGNORE_SHORT_TRANSCRIPTS)
        return false;
    const normalized = normalizedShortTranscript(text);
    if (!normalized)
        return false;
    return DEFAULT_IGNORED_TIMEOUT_TRANSCRIPTS.has(normalized);
}
function isMissingSttProviderError(message) {
    return /No STT provider available/i.test(message);
}
function compactErrorForBubble(error) {
    const raw = error instanceof Error ? error.message : String(error);
    const compact = raw.replace(/\s+/g, ' ').trim();
    if (!compact)
        return 'unknown error';
    if (isMissingSttProviderError(compact))
        return 'STT設定がありません。サーバー設定を確認してください。';
    if (compact.length <= PROCESS_ERROR_ALERT_MAX_CHARS)
        return compact;
    return `${compact.slice(0, PROCESS_ERROR_ALERT_MAX_CHARS - 3)}...`;
}
function buildProcessingErrorAlertMessage(error) {
    return `HERMES AI server error: ${compactErrorForBubble(error)}`;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null;
}
class Session {
    ws;
    sessionId = (0, crypto_1.randomUUID)();
    state = 'idle';
    version = 3;
    opusFrames = [];
    hermes;
    unregisterDeviceSession;
    decodeOpusFramesFn;
    createInputOpusDecoderFn;
    decodeOpusFrameFn;
    encodeWavToOpusFramesFn;
    transcribeWavFn;
    synthesizeTextFn;
    localVadConfig;
    localVad;
    bargeInConfig;
    bargeInVad;
    speechSegmentationConfig;
    autoLedConfig;
    localTtsOutputConfig;
    pendingMcp = new Map();
    nextMcpId = 1;
    silenceTimer;
    maxDurationTimer;
    delayedListenTimer;
    cooldownUntil = 0;
    postTtsCooldownMs;
    pcmChunks = [];
    preRollPcmChunks = [];
    streamingDecoder;
    streamingDecodeFailed = false;
    streamingDecodeFailures = 0;
    bargeInDecoder;
    bargeInDecodeFailed = false;
    bargeInDecodeFailures = 0;
    ttsStreaming = false;
    ttsStopSent = false;
    ttsGeneration = 0;
    ttsStartedAt = 0;
    manualLedHoldUntil = 0;
    lastAutoLedState;
    lastListenMode = '';
    processingSource = 'arrival-gap';
    currentSpeechMs = 0;
    followupQueue = [];
    followupRunning = false;
    fastAckEntries;
    fastAckFailed = false;
    lastFastAckIndex = -1;
    closed = false;
    constructor(ws, deps = {}) {
        this.ws = ws;
        // Per-device backend selection: read binding from WS handshake (Device-Id header)
        // Falls back to devices.json default, then to env var for backwards compat
        const binding = deps.deviceBinding ?? { backend: (process.env.STACKCHAN_BACKEND ?? 'hermes'), agent_id: process.env.STACKCHAN_AGENT_ID ?? 'your-agent' };
        const deviceId = deps.deviceId ?? 'unknown';
        this.hermes = deps.hermes ?? (binding.backend === 'openclaw' ? new openclaw_js_1.OpenClawClient({ agentId: binding.agent_id, deviceId }) : new hermes_js_1.HermesClient());
        this.decodeOpusFramesFn = deps.decodeOpusFrames ?? audio_js_1.decodeOpusFrames;
        this.createInputOpusDecoderFn = deps.createInputOpusDecoder ?? audio_js_1.createInputOpusDecoder;
        this.decodeOpusFrameFn = deps.decodeOpusFrame;
        this.encodeWavToOpusFramesFn = deps.encodeWavToOpusFrames ?? audio_js_1.encodeWavToOpusFrames;
        this.transcribeWavFn = deps.transcribeWav ?? hermes_audio_js_1.transcribeWithHermes;
        this.synthesizeTextFn = deps.synthesizeText ?? hermes_audio_js_1.synthesizeWithHermes;
        this.postTtsCooldownMs = deps.postTtsCooldownMs ?? POST_TTS_COOLDOWN_MS;
        this.localVadConfig = deps.localVadConfig ?? (0, local_vad_js_1.readLocalRmsVadConfig)();
        this.localVad = new local_vad_js_1.LocalRmsVad(this.localVadConfig);
        this.bargeInConfig = { ...(deps.bargeInConfig ?? BARGE_IN_CONFIG) };
        if (typeof deps.bargeInEnabled === 'boolean')
            this.bargeInConfig.enabled = deps.bargeInEnabled;
        this.bargeInVad = new local_vad_js_1.LocalRmsVad({
            enabled: this.bargeInConfig.enabled,
            rmsThreshold: this.bargeInConfig.rmsThreshold,
            startSpeechMs: this.bargeInConfig.startSpeechMs,
            endSilenceMs: 1000,
            minSpeechMs: this.bargeInConfig.minSpeechMs,
            preRollMs: 0,
        });
        this.speechSegmentationConfig = deps.speechSegmentationConfig ?? SPEECH_SEGMENTATION_CONFIG;
        this.autoLedConfig = { ...(deps.autoLedConfig ?? AUTO_LED_CONFIG) };
        this.localTtsOutputConfig = (0, local_audio_output_js_1.readLocalTtsOutputConfig)();
        if (typeof deps.autoLedEnabled === 'boolean')
            this.autoLedConfig.enabled = deps.autoLedEnabled;
        this.streamingDecoder = this.createInputOpusDecoderFn();
        this.bargeInDecoder = this.createInputOpusDecoderFn();
        this.unregisterDeviceSession = (deps.registerDeviceSession ?? device_control_js_1.registerDeviceSession)(this);
        if (FAST_ACK_ENABLED)
            void this.warmFastAck();
    }
    close() {
        this.closed = true;
        this.followupQueue = [];
        this.clearTimers();
        this.unregisterDeviceSession();
        this.streamingDecoder.dispose();
        this.bargeInDecoder.dispose();
        for (const [id, pending] of this.pendingMcp) {
            clearTimeout(pending.timer);
            pending.reject(new Error('StackChan WebSocket disconnected'));
            this.pendingMcp.delete(id);
        }
        void this.hermes.dispose();
    }
    handleMessage(data) {
        if (typeof data === 'string') {
            try {
                this.handleJson(JSON.parse(data));
            }
            catch (e) {
                console.error('[session] JSON parse error:', e);
            }
        }
        else {
            const str = data.toString('utf8');
            if (str.startsWith('{') || str.startsWith('[')) {
                try {
                    this.handleJson(JSON.parse(str));
                    return;
                }
                catch {
                    // JSON でなければバイナリとして処理
                }
            }
            this.handleBinary(data);
        }
    }
    handleBinary(data) {
        const payload = (0, audio_js_1.extractOpusPayload)(data, this.version);
        if (!payload)
            return;
        if (this.state === 'processing') {
            this.tryHandleBargeIn(payload);
            return;
        }
        if (this.state !== 'listening')
            return;
        this.handleListeningPayload(payload);
    }
    handleListeningPayload(payload) {
        this.opusFrames.push(payload);
        if (this.shouldUseLocalVad()) {
            this.handleVadPayload(payload);
        }
        else {
            this.resetSilenceTimer();
        }
    }
    shouldUseLocalVad() {
        return this.localVadConfig.enabled && !this.streamingDecodeFailed;
    }
    handleVadPayload(payload) {
        let pcm;
        try {
            pcm = this.decodeOpusFrameFn ? this.decodeOpusFrameFn(payload) : this.streamingDecoder.decodeFrame(payload);
        }
        catch (error) {
            this.streamingDecodeFailures += 1;
            this.recreateStreamingDecoder();
            this.localVad.reset();
            this.pcmChunks = [];
            this.currentSpeechMs = 0;
            if (this.streamingDecodeFailures >= STREAMING_DECODE_FAILURE_LIMIT) {
                this.streamingDecodeFailed = true;
                console.warn(`[session ${this.sessionId}] local VAD streaming decode failed ${this.streamingDecodeFailures} times, using arrival-gap timeout: ${String(error)}`);
            }
            else {
                console.warn(`[session ${this.sessionId}] local VAD streaming decode skipped invalid frame ${this.streamingDecodeFailures}/${STREAMING_DECODE_FAILURE_LIMIT}: ${String(error)}`);
            }
            this.resetSilenceTimer();
            return;
        }
        this.streamingDecodeFailures = 0;
        if (pcm.length === 0)
            return;
        const collectingBefore = this.pcmChunks.length > 0;
        if (collectingBefore) {
            this.pcmChunks.push(pcm);
        }
        else {
            this.appendPreRollPcm(pcm);
        }
        const result = this.localVad.processPcm(pcm);
        this.currentSpeechMs = result.speechMs;
        if (result.speechStarted && this.pcmChunks.length === 0) {
            this.pcmChunks = this.preRollPcmChunks.splice(0);
            this.armMaxDurationTimer();
            console.log(`[session ${this.sessionId}] vad speech started rms=${result.rms.toFixed(4)}`);
        }
        if (result.ignoredShortSpeech) {
            console.log(`[session ${this.sessionId}] vad ignored short speech speechMs=${result.speechMs} silenceMs=${result.silenceMs}`);
            this.preRollPcmChunks = this.pcmChunks.splice(0);
            this.localVad.reset();
            this.currentSpeechMs = 0;
            return;
        }
        if (result.utteranceEnded) {
            console.log(`[session ${this.sessionId}] vad silence ended speechMs=${result.speechMs} silenceMs=${result.silenceMs}`);
            this.triggerProcess('local-vad');
        }
    }
    appendPreRollPcm(pcm) {
        if (this.localVadConfig.preRollMs <= 0) {
            this.preRollPcmChunks = [];
            return;
        }
        this.preRollPcmChunks.push(pcm);
        const maxChunks = Math.max(1, Math.ceil(this.localVadConfig.preRollMs / audio_js_1.INPUT_FRAME_DURATION_MS));
        while (this.preRollPcmChunks.length > maxChunks) {
            this.preRollPcmChunks.shift();
        }
    }
    resetSilenceTimer() {
        if (this.silenceTimer)
            clearTimeout(this.silenceTimer);
        this.silenceTimer = setTimeout(() => {
            console.log(`[session ${this.sessionId}] silence detected, triggering process`);
            this.triggerProcess('arrival-gap');
        }, SILENCE_TIMEOUT_MS);
    }
    clearTimers() {
        if (this.silenceTimer) {
            clearTimeout(this.silenceTimer);
            this.silenceTimer = undefined;
        }
        if (this.maxDurationTimer) {
            clearTimeout(this.maxDurationTimer);
            this.maxDurationTimer = undefined;
        }
        if (this.delayedListenTimer) {
            clearTimeout(this.delayedListenTimer);
            this.delayedListenTimer = undefined;
        }
    }
    resetVadBuffers() {
        this.localVad.reset();
        this.pcmChunks = [];
        this.preRollPcmChunks = [];
        this.currentSpeechMs = 0;
    }
    resetCapture() {
        this.opusFrames = [];
        this.resetVadBuffers();
        this.recreateStreamingDecoder();
        this.streamingDecodeFailed = false;
        this.streamingDecodeFailures = 0;
    }
    resetBargeInDetector() {
        this.bargeInVad.reset();
        this.recreateBargeInDecoder();
        this.bargeInDecodeFailed = false;
        this.bargeInDecodeFailures = 0;
    }
    recreateStreamingDecoder() {
        this.streamingDecoder.dispose();
        this.streamingDecoder = this.createInputOpusDecoderFn();
    }
    recreateBargeInDecoder() {
        this.bargeInDecoder.dispose();
        this.bargeInDecoder = this.createInputOpusDecoderFn();
    }
    tryHandleBargeIn(payload) {
        if (!this.bargeInConfig.enabled || this.bargeInDecodeFailed)
            return false;
        if (!this.ttsStreaming)
            return false;
        if (Date.now() - this.ttsStartedAt < this.bargeInConfig.ignoreTtsStartMs)
            return false;
        let pcm;
        try {
            pcm = this.decodeOpusFrameFn ? this.decodeOpusFrameFn(payload) : this.bargeInDecoder.decodeFrame(payload);
        }
        catch (error) {
            this.bargeInDecodeFailures += 1;
            this.bargeInVad.reset();
            this.recreateBargeInDecoder();
            if (this.bargeInDecodeFailures >= BARGE_IN_DECODE_FAILURE_LIMIT) {
                this.bargeInDecodeFailed = true;
                console.warn(`[session ${this.sessionId}] barge-in decode failed ${this.bargeInDecodeFailures} times, disabled for current TTS: ${String(error)}`);
            }
            else {
                console.warn(`[session ${this.sessionId}] barge-in decode skipped invalid frame ${this.bargeInDecodeFailures}/${BARGE_IN_DECODE_FAILURE_LIMIT}: ${String(error)}`);
            }
            return false;
        }
        this.bargeInDecodeFailures = 0;
        const result = this.bargeInVad.processPcm(pcm);
        if (!result.inSpeech || result.speechMs < this.bargeInConfig.minSpeechMs)
            return false;
        console.log(`[session ${this.sessionId}] barge-in detected rms=${result.rms.toFixed(4)} speechMs=${result.speechMs}`);
        this.handleBargeIn(payload);
        return true;
    }
    handleBargeIn(firstPayload) {
        const interruptedGeneration = this.ttsGeneration;
        this.sendTtsStopOnce(interruptedGeneration);
        this.ttsGeneration += 1;
        this.ttsStreaming = false;
        this.cooldownUntil = 0;
        this.clearTimers();
        this.resetCapture();
        this.resetBargeInDetector();
        void this.hermes.interrupt().catch((error) => {
            console.error(`[session ${this.sessionId}] Hermes interrupt error:`, error);
        });
        this.startListening('barge-in');
        this.setAutoLedState('listening');
        this.handleListeningPayload(firstPayload);
    }
    triggerProcess(reason, force = false) {
        if (this.state !== 'listening')
            return;
        this.clearTimers();
        const hasVadPcm = this.pcmChunks.length > 0;
        const pcmBytes = this.pcmChunks.reduce((sum, chunk) => sum + chunk.length, 0);
        const minPcmBytes = Math.ceil((this.localVadConfig.minSpeechMs / 1000) * audio_js_1.INPUT_SAMPLE_RATE) * 2;
        if (!force && hasVadPcm && (this.currentSpeechMs < this.localVadConfig.minSpeechMs || pcmBytes < minPcmBytes)) {
            console.log(`[session ${this.sessionId}] too little VAD speech speechMs=${this.currentSpeechMs} pcmBytes=${pcmBytes}, restarting listen`);
            this.resetCapture();
            this.startListening('short-speech');
            return;
        }
        if (!force && !hasVadPcm && this.opusFrames.length < MIN_FRAMES_FOR_STT) {
            console.log(`[session ${this.sessionId}] too few frames (${this.opusFrames.length}), restarting listen`);
            this.resetCapture();
            this.startListening('too-few-frames');
            return;
        }
        this.processingSource = reason;
        this.state = 'processing';
        this.setAutoLedState('thinking');
        this.process().catch(async (err) => {
            console.error(`[session ${this.sessionId}] process error:`, err);
            this.setAutoLedState('error');
            this.sendProcessingErrorAlert(err);
            if (this.state === 'processing') {
                await this.speakSegments([PROCESS_ERROR_SPEECH], 'tts.error').catch((error) => {
                    console.error(`[session ${this.sessionId}] error speech failed:`, error);
                });
                this.sendProcessingErrorAlert(err);
            }
        }).finally(() => {
            if (this.state === 'processing') {
                if (this.shouldAutoResumeListening()) {
                    this.state = 'idle';
                    this.setAutoLedState('idle');
                    if (Date.now() < this.cooldownUntil) {
                        this.delayListeningUntilCooldownEnds('post-tts');
                    }
                    else {
                        this.startListening('post-tts');
                    }
                }
                else {
                    this.state = 'idle';
                    this.setAutoLedState('idle');
                }
            }
            this.drainFollowupQueue();
        });
    }
    shouldAutoResumeListening() {
        return AUTO_RESUME_LISTENING &&
            (this.lastListenMode === 'realtime' || this.lastListenMode === 'auto') &&
            !this.closed;
    }
    startListening(source) {
        this.clearTimers();
        this.state = 'listening';
        this.resetCapture();
        this.setAutoLedState('listening');
        if (!this.localVadConfig.enabled) {
            console.log(`[session ${this.sessionId}] local vad disabled, using arrival-gap timeout`);
        }
        this.armMaxDurationTimer();
        console.log(`[session ${this.sessionId}] listening started (${source})`);
    }
    armMaxDurationTimer() {
        if (this.maxDurationTimer)
            clearTimeout(this.maxDurationTimer);
        this.maxDurationTimer = setTimeout(() => {
            if (this.shouldUseLocalVad() && this.pcmChunks.length === 0 && this.currentSpeechMs === 0) {
                console.log(`[session ${this.sessionId}] max duration reached without VAD speech, restarting listen`);
                this.resetCapture();
                this.startListening('empty-timeout');
                return;
            }
            console.log(`[session ${this.sessionId}] max duration reached, triggering process`);
            this.triggerProcess('max-duration', true);
        }, MAX_RECORDING_MS);
    }
    delayListeningUntilCooldownEnds(source) {
        if (this.delayedListenTimer)
            clearTimeout(this.delayedListenTimer);
        this.resetCapture();
        const delayMs = Math.max(0, this.cooldownUntil - Date.now());
        this.delayedListenTimer = setTimeout(() => {
            this.delayedListenTimer = undefined;
            if (this.state !== 'idle')
                return;
            this.startListening(source);
        }, delayMs);
        console.log(`[session ${this.sessionId}] listen start delayed ${delayMs}ms (post-TTS cooldown)`);
    }
    handleJson(msg) {
        const type = msg['type'];
        if (type === 'hello') {
            this.version = msg['version'] ?? 3;
            this.sendJson({
                type: 'hello',
                transport: 'websocket',
                session_id: this.sessionId,
                audio_params: {
                    sample_rate: audio_js_1.OUTPUT_SAMPLE_RATE,
                    frame_duration: audio_js_1.OUTPUT_FRAME_DURATION_MS,
                },
            });
            console.log(`[session ${this.sessionId}] hello, protocol version=${this.version}`);
            return;
        }
        if (type === 'listen') {
            const listenState = msg['state'];
            if (listenState === 'start' || listenState === 'detect') {
                const isWakeWordStart = listenState === 'detect';
                const mode = String(msg['mode'] ?? '');
                const source = isWakeWordStart ? `wake_word=${String(msg['text'] ?? '')}` : `mode=${mode}`;
                if (!isWakeWordStart)
                    this.lastListenMode = mode;
                if (!isWakeWordStart && Date.now() < this.cooldownUntil) {
                    if (this.state === 'listening') {
                        console.log(`[session ${this.sessionId}] listen start already active (${source})`);
                        return;
                    }
                    this.delayListeningUntilCooldownEnds(source);
                    return;
                }
                this.startListening(source);
            }
            else if (listenState === 'stop') {
                this.triggerProcess('listen-stop', true);
            }
        }
        if (type === 'abort') {
            this.clearTimers();
            this.sendTtsStopOnce(this.ttsGeneration);
            this.ttsGeneration += 1;
            this.ttsStreaming = false;
            this.cooldownUntil = 0;
            this.state = 'idle';
            this.resetCapture();
            this.resetBargeInDetector();
            this.followupQueue = [];
            this.setAutoLedState('idle');
            void this.hermes.interrupt().catch((error) => {
                console.error(`[session ${this.sessionId}] Hermes interrupt error:`, error);
            });
            return;
        }
        if (type === 'mcp') {
            this.handleMcpPayload(msg['payload']);
        }
    }
    async process() {
        const processStartMs = (0, timing_js_1.nowMs)();
        const frames = this.opusFrames.splice(0);
        const vadPcm = this.pcmChunks.splice(0);
        this.preRollPcmChunks = [];
        const source = this.processingSource;
        console.log(`[session ${this.sessionId}] processing source=${source} frames=${frames.length} pcmBytes=${vadPcm.reduce((sum, chunk) => sum + chunk.length, 0)}`);
        if (frames.length === 0 && vadPcm.length === 0) {
            this.resumeListeningAfterIgnoredInput('empty-capture');
            return;
        }
        // 1. Opus -> PCM -> Hermes STT
        const pcm = vadPcm.length > 0
            ? Buffer.concat(vadPcm)
            : await (0, timing_js_1.withTiming)(`session:${this.sessionId}:audio.decode`, async () => this.decodeOpusFramesFn(frames), { frames: frames.length });
        if (pcm.length === 0) {
            this.resumeListeningAfterIgnoredInput('empty-pcm');
            return;
        }
        if (source === 'max-duration' && vadPcm.length === 0 && MAX_DURATION_STT_RMS_THRESHOLD > 0) {
            const rms = (0, local_vad_js_1.rmsNormalized)(pcm);
            if (rms < MAX_DURATION_STT_RMS_THRESHOLD) {
                console.log(`[session ${this.sessionId}] ignored low-rms max-duration audio rms=${rms.toFixed(4)} threshold=${MAX_DURATION_STT_RMS_THRESHOLD.toFixed(4)}`);
                this.resumeListeningAfterIgnoredInput('low-rms-timeout');
                return;
            }
        }
        const wavForStt = (0, audio_js_1.pcmToWav)(pcm, audio_js_1.INPUT_SAMPLE_RATE);
        const text = await (0, timing_js_1.withTiming)(`session:${this.sessionId}:stt`, () => this.transcribeWavFn(wavForStt), { pcmBytes: pcm.length });
        console.log(`[session ${this.sessionId}] STT: "${text}"`);
        if (!text.trim()) {
            this.resumeListeningAfterIgnoredInput('empty-transcript');
            return;
        }
        if (isIgnorableShortTranscript(text)) {
            console.log(`[session ${this.sessionId}] ignored short transcript: "${text}"`);
            this.resumeListeningAfterIgnoredInput('ignored-short-transcript');
            return;
        }
        if (source === 'max-duration' && vadPcm.length === 0 && isIgnorableTimeoutTranscript(text)) {
            console.log(`[session ${this.sessionId}] ignored timeout transcript: "${text}"`);
            this.resumeListeningAfterIgnoredInput('ignored-timeout-transcript');
            return;
        }
        this.sendJson({ type: 'stt', text });
        await this.trySpeakFastAck();
        // 2. Hermes LLM turn -> 3. Hermes TTS -> Opus -> device
        await this.speakHermesReply(text, 'llm', 'tts');
        if (this.state === 'processing')
            this.setAutoLedState('idle');
        console.log(`[timing] done session:${this.sessionId}:process elapsed=${(0, timing_js_1.elapsedMs)(processStartMs)}`);
    }
    resumeListeningAfterIgnoredInput(source) {
        if (this.state !== 'processing' || this.closed)
            return;
        this.startListening(source);
    }
    async enqueueFollowup(prompt) {
        const cleanPrompt = prompt.trim();
        if (!cleanPrompt || this.closed)
            return;
        this.followupQueue.push(cleanPrompt);
        if (this.state === 'listening') {
            this.clearTimers();
            this.resetCapture();
            this.state = 'idle';
            this.setAutoLedState('idle');
        }
        this.drainFollowupQueue();
    }
    getBridgeStatus() {
        const cooldownRemainingMs = Math.max(0, this.cooldownUntil - Date.now());
        const readyForPrompt = !this.closed &&
            this.state === 'listening' &&
            !this.ttsStreaming &&
            cooldownRemainingMs === 0 &&
            !this.followupRunning &&
            this.followupQueue.length === 0 &&
            this.delayedListenTimer === undefined;
        let reason = 'ready';
        if (this.closed)
            reason = 'closed';
        else if (this.state !== 'listening')
            reason = `state_${this.state}`;
        else if (this.ttsStreaming)
            reason = 'tts_streaming';
        else if (cooldownRemainingMs > 0)
            reason = 'post_tts_cooldown';
        else if (this.followupRunning)
            reason = 'followup_running';
        else if (this.followupQueue.length > 0)
            reason = 'followup_queued';
        else if (this.delayedListenTimer !== undefined)
            reason = 'listen_delayed';
        return {
            connected: !this.closed,
            sessionId: this.sessionId,
            state: this.state,
            readyForPrompt,
            reason,
            ttsStreaming: this.ttsStreaming,
            cooldownRemainingMs,
            followupRunning: this.followupRunning,
            followupQueued: this.followupQueue.length,
            pendingMcp: this.pendingMcp.size,
            lastListenMode: this.lastListenMode,
        };
    }
    drainFollowupQueue() {
        if (this.closed || this.followupRunning || this.state !== 'idle')
            return;
        const prompt = this.followupQueue.shift();
        if (!prompt)
            return;
        this.followupRunning = true;
        this.state = 'processing';
        this.setAutoLedState('thinking');
        this.processFollowup(prompt).catch(async (err) => {
            console.error(`[session ${this.sessionId}] follow-up error:`, err);
            this.setAutoLedState('error');
            this.sendProcessingErrorAlert(err);
            if (this.state === 'processing') {
                await this.speakSegments([PROCESS_ERROR_SPEECH], 'tts.followup.error').catch((error) => {
                    console.error(`[session ${this.sessionId}] follow-up error speech failed:`, error);
                });
                this.sendProcessingErrorAlert(err);
            }
        }).finally(() => {
            this.followupRunning = false;
            if (this.state === 'processing') {
                this.state = 'idle';
                this.setAutoLedState('idle');
                if (this.shouldAutoResumeListening()) {
                    if (Date.now() < this.cooldownUntil) {
                        this.delayListeningUntilCooldownEnds('post-followup');
                    }
                    else {
                        this.startListening('post-followup');
                    }
                }
            }
            this.drainFollowupQueue();
        });
    }
    async processFollowup(prompt) {
        const followupStartMs = (0, timing_js_1.nowMs)();
        console.log(`[session ${this.sessionId}] follow-up prompt queued length=${prompt.length}`);
        await this.speakHermesReply(prompt, 'followup.llm', 'tts.followup');
        console.log(`[timing] done session:${this.sessionId}:followup elapsed=${(0, timing_js_1.elapsedMs)(followupStartMs)}`);
    }
    async speakHermesReply(prompt, llmLabel, ttsLabel) {
        const hermesPrompt = stackChanVoicePrompt(prompt);
        if (this.hermes.streamPrompt && readEnvBool('STACKCHAN_STREAM_LLM_TTS', true)) {
            return await this.speakHermesReplyStreaming(hermesPrompt, llmLabel, ttsLabel);
        }
        return await this.speakHermesReplyBuffered(hermesPrompt, llmLabel, ttsLabel);
    }
    async speakHermesReplyBuffered(prompt, llmLabel, ttsLabel) {
        const processingKeepalive = setInterval(() => {
            this.sendJson({ type: 'llm', emotion: 'doubtful' });
        }, PROCESSING_KEEPALIVE_MS);
        this.sendJson({ type: 'llm', emotion: 'doubtful' });
        let reply;
        try {
            reply = await (0, timing_js_1.withTiming)(`session:${this.sessionId}:${llmLabel}`, () => this.hermes.submitPrompt(prompt), { textLength: prompt.length });
        }
        finally {
            clearInterval(processingKeepalive);
        }
        console.log(`[session ${this.sessionId}] LLM(${llmLabel}): "${reply}"`);
        this.sendJson({ type: 'llm', emotion: inferStackChanEmotion(reply) });
        void this.displayFirstImageFromReply(reply);
        const speechSegments = splitStackChanSpeechText(reply, this.speechSegmentationConfig);
        await this.speakSegments(speechSegments, ttsLabel);
        return reply;
    }
    async speakHermesReplyStreaming(prompt, llmLabel, ttsLabel) {
        const streamPrompt = this.hermes.streamPrompt;
        if (!streamPrompt)
            return await this.speakHermesReplyBuffered(prompt, llmLabel, ttsLabel);
        const processingKeepalive = setInterval(() => {
            this.sendJson({ type: 'llm', emotion: 'doubtful' });
        }, PROCESSING_KEEPALIVE_MS);
        this.sendJson({ type: 'llm', emotion: 'doubtful' });
        const llmStartMs = (0, timing_js_1.nowMs)();
        let reply = '';
        let spokenSegments = 0;
        let playback;
        try {
            for await (const event of streamPrompt.call(this.hermes, prompt)) {
                if (event.type === 'delta') {
                    reply += event.text;
                }
                else if (event.type === 'complete' && event.text) {
                    reply = event.text;
                }
                if (this.state !== 'processing')
                    break;
                const stableSegments = stableSpeechSegmentsFromPartialReply(reply, this.speechSegmentationConfig);
                while (spokenSegments < stableSegments.length && this.state === 'processing') {
                    playback ??= this.startTtsPlayback(ttsLabel);
                    await this.speakSegmentInPlayback(playback, stableSegments[spokenSegments], `${ttsLabel}.stream.segment${spokenSegments}`, spokenSegments);
                    spokenSegments += 1;
                    if (playback.interrupted)
                        break;
                }
                if (STOP_LLM_AFTER_MAX_SPOKEN_SEGMENTS &&
                    spokenSegments >= this.speechSegmentationConfig.maxSegments) {
                    console.log(`[session ${this.sessionId}] stopping LLM stream after spoken segment limit (${spokenSegments})`);
                    void this.hermes.interrupt().catch((error) => {
                        console.error(`[session ${this.sessionId}] Hermes interrupt after speech limit error:`, error);
                    });
                    break;
                }
            }
        }
        finally {
            clearInterval(processingKeepalive);
        }
        console.log(`[timing] done session:${this.sessionId}:${llmLabel}.stream elapsed=${(0, timing_js_1.elapsedMs)(llmStartMs)}`);
        console.log(`[session ${this.sessionId}] LLM(${llmLabel}): "${reply}"`);
        this.sendJson({ type: 'llm', emotion: inferStackChanEmotion(reply) });
        void this.displayFirstImageFromReply(reply);
        const finalSegments = splitStackChanSpeechText(reply, this.speechSegmentationConfig);
        if (!playback) {
            await this.speakSegments(finalSegments, ttsLabel);
            return reply;
        }
        try {
            const remainingSegments = finalSegments.slice(spokenSegments);
            await this.speakSegmentsInPlayback(playback, remainingSegments, ttsLabel, spokenSegments);
        }
        finally {
            await this.finishTtsPlayback(playback);
        }
        return reply;
    }
    async synthesizeSegment(speechText, label, leadSilenceMs = 0) {
        const wav = await (0, timing_js_1.withTiming)(`session:${this.sessionId}:${label}.synthesize`, () => this.synthesizeTextFn(speechText), { textLength: speechText.length });
        if (leadSilenceMs > 0) {
            console.log(`[session ${this.sessionId}] tts preroll ${leadSilenceMs}ms`);
        }
        const opusFrames = await (0, timing_js_1.withTiming)(`session:${this.sessionId}:${label}.encode`, async () => this.encodeWavToOpusFramesFn(wav, leadSilenceMs), { wavBytes: wav.length, leadSilenceMs });
        return { wav, opusFrames };
    }
    async warmFastAck() {
        if (this.fastAckEntries || this.fastAckFailed)
            return;
        try {
            this.fastAckEntries = [];
            for (let index = 0; index < FAST_ACK_TEXTS.length; index++) {
                const text = FAST_ACK_TEXTS[index];
                const audio = await this.synthesizeSegment(text, `tts.fast_ack.cache${index}`, TTS_PREROLL_MS);
                this.fastAckEntries.push({ text, wav: audio.wav, frames: audio.opusFrames });
            }
            console.log(`[session ${this.sessionId}] fast ack cached variants=${this.fastAckEntries.length}`);
        }
        catch (error) {
            this.fastAckFailed = true;
            console.warn(`[session ${this.sessionId}] fast ack cache failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    pickFastAck() {
        if (!this.fastAckEntries || this.fastAckEntries.length === 0)
            return undefined;
        if (this.fastAckEntries.length === 1)
            return this.fastAckEntries[0];
        let index = Math.floor(Math.random() * this.fastAckEntries.length);
        if (index === this.lastFastAckIndex) {
            index = (index + 1 + Math.floor(Math.random() * (this.fastAckEntries.length - 1))) % this.fastAckEntries.length;
        }
        this.lastFastAckIndex = index;
        return this.fastAckEntries[index];
    }
    async trySpeakFastAck() {
        if (!FAST_ACK_ENABLED || this.fastAckFailed)
            return;
        if (!this.fastAckEntries) {
            void this.warmFastAck();
            return;
        }
        const ack = this.pickFastAck();
        if (!ack)
            return;
        const playback = this.startTtsPlayback('tts.fast_ack');
        try {
            console.log(`[session ${this.sessionId}] fast ack selected: "${ack.text}"`);
            await this.speakCachedSegmentInPlayback(playback, ack.text, ack.wav, ack.frames, 0);
        }
        finally {
            await this.finishTtsPlayback(playback);
        }
    }
    async speakSegments(segments, label) {
        if (segments.length === 0)
            return;
        const playback = this.startTtsPlayback(label);
        try {
            await this.speakSegmentsInPlayback(playback, segments, label, 0);
        }
        finally {
            await this.finishTtsPlayback(playback);
        }
    }
    startTtsPlayback(label) {
        const generation = this.ttsGeneration + 1;
        this.ttsGeneration = generation;
        this.ttsStopSent = false;
        this.ttsStreaming = true;
        this.ttsStartedAt = Date.now();
        this.resetBargeInDetector();
        this.sendJson({ type: 'tts', state: 'start' });
        this.setAutoLedState('speaking');
        return {
            generation,
            label,
            streamStartMs: (0, timing_js_1.nowMs)(),
            streamedFrames: 0,
            segmentCount: 0,
            interrupted: false,
            firstFrameLogged: false,
            firstAudibleFrameLogged: false,
            localOutputChecked: false,
            m5SpeakerMutedForLocalOutput: false,
        };
    }
    isTtsPlaybackActive(playback) {
        return this.state === 'processing' && this.ttsGeneration === playback.generation;
    }
    prefetchSegment(segment, label, index) {
        const promise = this.synthesizeSegment(segment, `${label}.segment${index}`);
        promise.catch(() => undefined);
        return { index, promise };
    }
    async speakSegmentsInPlayback(playback, segments, label, startIndex) {
        let prefetched;
        try {
            for (let offset = 0; offset < segments.length; offset++) {
                const index = startIndex + offset;
                if (!this.isTtsPlaybackActive(playback)) {
                    playback.interrupted = true;
                    break;
                }
                const segment = segments[offset];
                const framesPromise = prefetched?.index === index ? prefetched.promise : undefined;
                prefetched = undefined;
                const nextSegment = segments[offset + 1];
                await this.speakSegmentInPlayback(playback, segment, `${label}.segment${index}`, index, framesPromise, () => {
                    if (nextSegment && this.isTtsPlaybackActive(playback)) {
                        prefetched = this.prefetchSegment(nextSegment, label, index + 1);
                    }
                });
                if (playback.interrupted)
                    break;
            }
        }
        finally {
            prefetched?.promise.catch(() => undefined);
        }
    }
    async speakSegmentInPlayback(playback, segment, label, index, framesPromise, onFramesReady) {
        if (!this.isTtsPlaybackActive(playback)) {
            playback.interrupted = true;
            return;
        }
        this.sendJson({ type: 'tts', state: 'sentence_start', text: segment, index });
        await this.prepareLocalTtsOutput(playback);
        const leadSilenceMs = playback.localOutputTarget
            ? 0
            : (index === 0 && playback.streamedFrames === 0 ? TTS_PREROLL_MS : 0);
        const audio = framesPromise ? await framesPromise : await this.synthesizeSegment(segment, label, leadSilenceMs);
        onFramesReady?.();
        const localPlayback = this.startLocalSegmentPlayback(playback, audio.wav);
        const leadSilenceFrames = Math.ceil(leadSilenceMs / audio_js_1.OUTPUT_FRAME_DURATION_MS);
        for (let frameIndex = 0; frameIndex < audio.opusFrames.length; frameIndex++) {
            const frame = audio.opusFrames[frameIndex];
            if (!this.isTtsPlaybackActive(playback)) {
                playback.interrupted = true;
                break;
            }
            this.sendBinary((0, audio_js_1.wrapOpusPayload)(frame, this.version));
            playback.streamedFrames += 1;
            this.logTtsFrameMilestones(playback, frameIndex >= leadSilenceFrames);
            await new Promise(resolve => setTimeout(resolve, audio_js_1.OUTPUT_FRAME_DURATION_MS));
        }
        await localPlayback;
        if (!this.isTtsPlaybackActive(playback)) {
            playback.interrupted = true;
            return;
        }
        playback.segmentCount += 1;
        this.sendJson({ type: 'tts', state: 'sentence_end', text: segment, index });
    }
    async speakCachedSegmentInPlayback(playback, segment, wav, opusFrames, index) {
        if (!this.isTtsPlaybackActive(playback)) {
            playback.interrupted = true;
            return;
        }
        this.sendJson({ type: 'tts', state: 'sentence_start', text: segment, index });
        await this.prepareLocalTtsOutput(playback);
        const localPlayback = this.startLocalSegmentPlayback(playback, wav);
        const leadSilenceFrames = !playback.localOutputTarget && index === 0 && playback.streamedFrames === 0
            ? Math.ceil(TTS_PREROLL_MS / audio_js_1.OUTPUT_FRAME_DURATION_MS)
            : 0;
        for (let frameIndex = 0; frameIndex < opusFrames.length; frameIndex++) {
            const frame = opusFrames[frameIndex];
            if (!this.isTtsPlaybackActive(playback)) {
                playback.interrupted = true;
                break;
            }
            this.sendBinary((0, audio_js_1.wrapOpusPayload)(frame, this.version));
            playback.streamedFrames += 1;
            this.logTtsFrameMilestones(playback, frameIndex >= leadSilenceFrames);
            await new Promise(resolve => setTimeout(resolve, audio_js_1.OUTPUT_FRAME_DURATION_MS));
        }
        await localPlayback;
        if (!this.isTtsPlaybackActive(playback)) {
            playback.interrupted = true;
            return;
        }
        playback.segmentCount += 1;
        this.sendJson({ type: 'tts', state: 'sentence_end', text: segment, index });
    }
    async prepareLocalTtsOutput(playback) {
        if (playback.localOutputChecked)
            return;
        playback.localOutputChecked = true;
        if (!this.localTtsOutputConfig.enabled)
            return;
        try {
            const target = await (0, local_audio_output_js_1.resolveLocalTtsOutputTarget)(this.localTtsOutputConfig);
            if (!target) {
                console.log(`[session ${this.sessionId}] local TTS output unavailable; using M5 speaker`);
                return;
            }
            await this.callRobotToolInternal('self.robot.set_speaker_volume', {
                volume: 0,
                permanent: false,
            }, { automatic: true, waitForResponse: true });
            playback.localOutputTarget = target;
            playback.m5SpeakerMutedForLocalOutput = true;
            console.log(`[session ${this.sessionId}] local TTS output active target=${target}; M5 speaker muted temporarily`);
        }
        catch (error) {
            console.warn(`[session ${this.sessionId}] local TTS output setup failed; using M5 speaker: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    startLocalSegmentPlayback(playback, wav) {
        const target = playback.localOutputTarget;
        if (!target)
            return Promise.resolve();
        return (0, local_audio_output_js_1.playWavOnLocalTarget)(target, wav).catch(async (error) => {
            console.warn(`[session ${this.sessionId}] local TTS playback failed; restoring M5 speaker: ${error instanceof Error ? error.message : String(error)}`);
            playback.localOutputTarget = undefined;
            await this.restoreM5SpeakerAfterLocalOutput(playback);
        });
    }
    async restoreM5SpeakerAfterLocalOutput(playback) {
        if (!playback.m5SpeakerMutedForLocalOutput)
            return;
        playback.m5SpeakerMutedForLocalOutput = false;
        try {
            await this.callRobotToolInternal('self.robot.set_speaker_volume', {
                volume: this.localTtsOutputConfig.fallbackM5Volume,
                permanent: false,
            }, { automatic: true, waitForResponse: true });
            console.log(`[session ${this.sessionId}] M5 speaker restored volume=${this.localTtsOutputConfig.fallbackM5Volume}`);
        }
        catch (error) {
            console.error(`[session ${this.sessionId}] failed to restore M5 speaker after local TTS:`, error);
        }
    }
    logTtsFrameMilestones(playback, audibleFrame) {
        if (!playback.firstFrameLogged) {
            playback.firstFrameLogged = true;
            console.log(`[timing] mark session:${this.sessionId}:${playback.label}.first_frame_sent elapsed=${(0, timing_js_1.elapsedMs)(playback.streamStartMs)} frames=${playback.streamedFrames}`);
        }
        if (audibleFrame && !playback.firstAudibleFrameLogged) {
            playback.firstAudibleFrameLogged = true;
            console.log(`[timing] mark session:${this.sessionId}:${playback.label}.first_audible_frame_sent elapsed=${(0, timing_js_1.elapsedMs)(playback.streamStartMs)} frames=${playback.streamedFrames}`);
        }
    }
    async finishTtsPlayback(playback) {
        this.sendTtsStopOnce(playback.generation);
        if (this.ttsGeneration === playback.generation) {
            this.ttsStreaming = false;
            this.resetBargeInDetector();
        }
        console.log(`[timing] done session:${this.sessionId}:${playback.label}.stream elapsed=${(0, timing_js_1.elapsedMs)(playback.streamStartMs)} frames=${playback.streamedFrames} segments=${playback.segmentCount}`);
        if (!playback.interrupted && this.state === 'processing' && this.ttsGeneration === playback.generation) {
            // TTS 再生後のエコー誤検知を防ぐためクールダウンを設定
            this.cooldownUntil = Date.now() + this.postTtsCooldownMs;
        }
        await this.restoreM5SpeakerAfterLocalOutput(playback);
    }
    sendTtsStopOnce(generation) {
        if (!this.ttsStreaming && this.ttsGeneration === generation)
            return;
        if (this.ttsGeneration !== generation)
            return;
        if (this.ttsStopSent)
            return;
        this.ttsStopSent = true;
        this.sendJson({ type: 'tts', state: 'stop' });
    }
    async displayFirstImageFromReply(reply) {
        const source = (0, media_js_1.extractFirstDisplayImage)(reply);
        if (!source)
            return;
        try {
            const url = (0, media_js_1.resolveDisplayImageSource)(source);
            if (!url)
                return;
            await this.callRobotTool('self.screen.preview_image_url', {
                url,
                duration_seconds: 6,
            });
        }
        catch (error) {
            console.error(`[session ${this.sessionId}] display image error:`, error);
        }
    }
    async callRobotTool(name, args) {
        return await this.callRobotToolInternal(name, args, { automatic: false, waitForResponse: true });
    }
    async callRobotToolInternal(name, args, options) {
        if (name === 'self.robot.set_led_color' && !options.automatic) {
            this.manualLedHoldUntil = Date.now() + this.autoLedConfig.manualHoldMs;
        }
        const id = this.nextMcpId++;
        const payload = {
            jsonrpc: '2.0',
            id,
            method: 'tools/call',
            params: { name, arguments: args },
        };
        if (!options.waitForResponse) {
            this.sendJson({ type: 'mcp', session_id: this.sessionId, payload });
            return undefined;
        }
        return await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingMcp.delete(id);
                reject(new Error(`StackChan robot tool timed out: ${name}`));
            }, MCP_REQUEST_TIMEOUT_MS);
            this.pendingMcp.set(id, { resolve, reject, timer });
            this.sendJson({ type: 'mcp', session_id: this.sessionId, payload });
        });
    }
    setAutoLedState(state) {
        if (!this.autoLedConfig.enabled)
            return;
        if (Date.now() < this.manualLedHoldUntil)
            return;
        if (this.lastAutoLedState === state)
            return;
        this.lastAutoLedState = state;
        const colors = {
            listening: { red: 0, green: 32, blue: 0 },
            thinking: { red: 32, green: 24, blue: 0 },
            speaking: { red: 0, green: 0, blue: 40 },
            idle: { red: 0, green: 0, blue: 0 },
            error: { red: 48, green: 0, blue: 0 },
        };
        void this.callRobotToolInternal('self.robot.set_led_color', colors[state], {
            automatic: true,
            waitForResponse: false,
        }).catch((error) => {
            console.error(`[session ${this.sessionId}] auto LED error:`, error);
        });
    }
    handleMcpPayload(payload) {
        if (!isRecord(payload) || typeof payload['id'] !== 'number')
            return;
        const pending = this.pendingMcp.get(payload['id']);
        if (!pending)
            return;
        clearTimeout(pending.timer);
        this.pendingMcp.delete(payload['id']);
        if (isRecord(payload['error'])) {
            pending.reject(new Error(String(payload['error']['message'] ?? 'StackChan robot tool failed')));
            return;
        }
        pending.resolve(payload['result']);
    }
    sendProcessingErrorAlert(error) {
        this.sendJson({
            type: 'alert',
            status: 'HERMES AI ERROR',
            message: buildProcessingErrorAlertMessage(error),
            emotion: 'sad',
        });
    }
    sendJson(obj) {
        try {
            this.ws.send(JSON.stringify(obj));
        }
        catch {
            // 切断済みの場合は無視
        }
    }
    sendBinary(data) {
        try {
            this.ws.send(data);
        }
        catch {
            // 切断済みの場合は無視
        }
    }
}
exports.Session = Session;
