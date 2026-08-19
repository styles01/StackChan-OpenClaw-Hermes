"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LocalRmsVad = exports.LOCAL_VAD_FRAME_BYTES = exports.LOCAL_VAD_FRAME_SAMPLES = exports.LOCAL_VAD_FRAME_MS = exports.LOCAL_VAD_SAMPLE_RATE = void 0;
exports.readEnvInt = readEnvInt;
exports.readEnvFloat = readEnvFloat;
exports.readEnvBool = readEnvBool;
exports.readLocalRmsVadConfig = readLocalRmsVadConfig;
exports.rmsNormalized = rmsNormalized;
exports.LOCAL_VAD_SAMPLE_RATE = 16000;
exports.LOCAL_VAD_FRAME_MS = 30;
exports.LOCAL_VAD_FRAME_SAMPLES = (exports.LOCAL_VAD_SAMPLE_RATE * exports.LOCAL_VAD_FRAME_MS) / 1000;
exports.LOCAL_VAD_FRAME_BYTES = exports.LOCAL_VAD_FRAME_SAMPLES * 2;
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
function readLocalRmsVadConfig(env = process.env) {
    return {
        enabled: readEnvBool('STACKCHAN_LOCAL_VAD_ENABLED', false, env),
        rmsThreshold: readEnvFloat('STACKCHAN_VAD_RMS_THRESHOLD', 0.012, 0.001, 0.2, env),
        startSpeechMs: readEnvInt('STACKCHAN_VAD_START_SPEECH_MS', 120, exports.LOCAL_VAD_FRAME_MS, 2000, env),
        endSilenceMs: readEnvInt('STACKCHAN_VAD_END_SILENCE_MS', 900, exports.LOCAL_VAD_FRAME_MS, 5000, env),
        minSpeechMs: readEnvInt('STACKCHAN_VAD_MIN_SPEECH_MS', 240, exports.LOCAL_VAD_FRAME_MS, 5000, env),
        preRollMs: readEnvInt('STACKCHAN_VAD_PREROLL_MS', 300, 0, 3000, env),
    };
}
function rmsNormalized(pcm) {
    const samples = Math.floor(pcm.length / 2);
    if (samples === 0)
        return 0;
    let sumSquares = 0;
    for (let i = 0; i < samples; i++) {
        const sample = pcm.readInt16LE(i * 2);
        sumSquares += sample * sample;
    }
    return Math.sqrt(sumSquares / samples) / 32768;
}
const EMPTY_RESULT = {
    speechStarted: false,
    inSpeech: false,
    utteranceEnded: false,
    ignoredShortSpeech: false,
    speechMs: 0,
    silenceMs: 0,
    rms: 0,
};
class LocalRmsVad {
    config;
    pending = Buffer.alloc(0);
    speechRunMs = 0;
    activeSpeechMs = 0;
    silenceRunMs = 0;
    started = false;
    lastRms = 0;
    constructor(config = readLocalRmsVadConfig()) {
        this.config = config;
    }
    reset() {
        this.pending = Buffer.alloc(0);
        this.speechRunMs = 0;
        this.activeSpeechMs = 0;
        this.silenceRunMs = 0;
        this.started = false;
        this.lastRms = 0;
    }
    processPcm(pcm) {
        if (!this.config.enabled || pcm.length === 0) {
            return { ...EMPTY_RESULT, inSpeech: this.started, speechMs: this.activeSpeechMs, silenceMs: this.silenceRunMs };
        }
        let speechStarted = false;
        let utteranceEnded = false;
        let ignoredShortSpeech = false;
        let data = this.pending.length > 0 ? Buffer.concat([this.pending, pcm]) : pcm;
        while (data.length >= exports.LOCAL_VAD_FRAME_BYTES) {
            const chunk = data.subarray(0, exports.LOCAL_VAD_FRAME_BYTES);
            data = data.subarray(exports.LOCAL_VAD_FRAME_BYTES);
            const rms = rmsNormalized(chunk);
            this.lastRms = rms;
            const voiced = rms >= this.config.rmsThreshold;
            if (!this.started) {
                if (voiced) {
                    this.speechRunMs += exports.LOCAL_VAD_FRAME_MS;
                    if (this.speechRunMs >= this.config.startSpeechMs) {
                        this.started = true;
                        speechStarted = true;
                        this.activeSpeechMs = this.speechRunMs;
                        this.silenceRunMs = 0;
                    }
                }
                else {
                    this.speechRunMs = 0;
                }
                continue;
            }
            if (voiced) {
                this.activeSpeechMs += exports.LOCAL_VAD_FRAME_MS;
                this.silenceRunMs = 0;
            }
            else {
                this.silenceRunMs += exports.LOCAL_VAD_FRAME_MS;
                if (this.silenceRunMs >= this.config.endSilenceMs) {
                    if (this.activeSpeechMs >= this.config.minSpeechMs) {
                        utteranceEnded = true;
                    }
                    else {
                        ignoredShortSpeech = true;
                    }
                    break;
                }
            }
        }
        this.pending = Buffer.from(data);
        const result = {
            speechStarted,
            inSpeech: this.started,
            utteranceEnded,
            ignoredShortSpeech,
            speechMs: this.activeSpeechMs,
            silenceMs: this.silenceRunMs,
            rms: this.lastRms,
        };
        if (utteranceEnded || ignoredShortSpeech) {
            this.reset();
        }
        return result;
    }
}
exports.LocalRmsVad = LocalRmsVad;
