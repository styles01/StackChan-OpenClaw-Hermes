"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.transcribeWithHermes = transcribeWithHermes;
exports.synthesizeWithHermes = synthesizeWithHermes;
const child_process_1 = require("child_process");
const promises_1 = require("fs/promises");
const os_1 = require("os");
const path_1 = __importDefault(require("path"));
const crypto_1 = require("crypto");
const TEMP_ROOT = path_1.default.join((0, os_1.tmpdir)(), 'stackchan-hermes');
function hermesRoot() {
    return process.env.HERMES_ROOT ?? path_1.default.resolve(process.cwd(), '..', 'hermes-agent');
}
function pythonCommand() {
    return process.env.HERMES_PYTHON ?? 'python3';
}
function run(command, args, options) {
    return new Promise((resolve, reject) => {
        const child = (0, child_process_1.spawn)(command, args, {
            cwd: options?.cwd,
            env: options?.env,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const stdout = [];
        const stderr = [];
        child.stdout.on('data', (chunk) => stdout.push(chunk));
        child.stderr.on('data', (chunk) => stderr.push(chunk));
        child.on('error', reject);
        child.on('close', (code) => {
            const result = {
                stdout: Buffer.concat(stdout).toString('utf8'),
                stderr: Buffer.concat(stderr).toString('utf8'),
            };
            if (code === 0)
                resolve(result);
            else
                reject(new Error(`${command} exited with code ${code}: ${result.stderr || result.stdout}`));
        });
    });
}
function hermesPythonEnv() {
    const root = hermesRoot();
    const localOnly = process.env.STACKCHAN_LOCAL_ONLY;
    return {
        ...process.env,
        ...(localOnly ? { STACKCHAN_LOCAL_ONLY: localOnly, HERMES_LOCAL_ONLY: '1' } : {}),
        PYTHONPATH: [root, process.env.PYTHONPATH].filter(Boolean).join(path_1.default.delimiter),
    };
}
function configuredSttUrl() {
    return process.env.HERMES_STT_URL ?? process.env.STACKCHAN_STT_URL ?? '';
}
function configuredLocalTtsUrl() {
    return process.env.STACKCHAN_LOCAL_TTS_URL ?? '';
}
function readTimeoutMs(name, fallback) {
    const value = Number(process.env[name] ?? fallback);
    if (!Number.isFinite(value))
        return fallback;
    return Math.max(500, Math.min(120_000, Math.round(value)));
}
async function transcribeWithOpenAiCompatibleStt(wav, url) {
    const form = new FormData();
    form.append('model', process.env.HERMES_STT_MODEL ?? process.env.STACKCHAN_STT_MODEL ?? 'whisper-1');
    form.append('language', process.env.HERMES_STT_LANGUAGE ?? process.env.HERMES_LOCAL_STT_LANGUAGE ?? 'ja');
    form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'input.wav');
    const apiKey = process.env.HERMES_STT_API_KEY ?? process.env.WHISPER_API_KEY ?? '';
    const response = await fetch(url, {
        method: 'POST',
        headers: apiKey ? { authorization: `Bearer ${apiKey}` } : undefined,
        body: form,
    });
    const text = await response.text();
    if (!response.ok)
        throw new Error(`STT endpoint failed: HTTP ${response.status}: ${text}`);
    const result = JSON.parse(text);
    return String(result.text ?? result.transcript ?? result.result ?? '').trim();
}
async function withTempDir(fn) {
    await (0, promises_1.mkdir)(TEMP_ROOT, { recursive: true });
    const dir = path_1.default.join(TEMP_ROOT, (0, crypto_1.randomUUID)());
    await (0, promises_1.mkdir)(dir, { recursive: true });
    try {
        return await fn(dir);
    }
    finally {
        await (0, promises_1.rm)(dir, { recursive: true, force: true });
    }
}
function parseJson(stdout, label) {
    const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
    if (!line)
        throw new Error(`${label} produced no JSON output`);
    return JSON.parse(line);
}
async function transcribeWithHermes(wav) {
    const sttUrl = configuredSttUrl();
    if (sttUrl)
        return await transcribeWithOpenAiCompatibleStt(wav, sttUrl);
    return await withTempDir(async (dir) => {
        const inputPath = path_1.default.join(dir, 'input.wav');
        await (0, promises_1.writeFile)(inputPath, wav);
        const script = [
            'import json, sys',
            'from tools.transcription_tools import transcribe_audio',
            'print(json.dumps(transcribe_audio(sys.argv[1]), ensure_ascii=False))',
        ].join('\n');
        const { stdout } = await run(pythonCommand(), ['-c', script, inputPath], {
            cwd: hermesRoot(),
            env: hermesPythonEnv(),
        });
        const result = parseJson(stdout, 'Hermes transcription');
        if (!result.success)
            throw new Error(result.error ?? 'Hermes transcription failed');
        return result.transcript ?? '';
    });
}
async function synthesizeWithLocalHttpTts(text, url) {
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        body: text,
        signal: AbortSignal.timeout(readTimeoutMs('STACKCHAN_LOCAL_TTS_TIMEOUT_MS', 15_000)),
    });
    if (!response.ok) {
        const detail = await response.text();
        throw new Error(`Local TTS endpoint failed: HTTP ${response.status}: ${detail}`);
    }
    const wav = Buffer.from(await response.arrayBuffer());
    if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
        throw new Error('Local TTS endpoint did not return a valid WAV file');
    }
    return wav;
}
async function synthesizeWithHermes(text) {
    const localTtsUrl = configuredLocalTtsUrl();
    if (localTtsUrl)
        return await synthesizeWithLocalHttpTts(text, localTtsUrl);
    return await withTempDir(async (dir) => {
        const outputPath = path_1.default.join(dir, 'speech.wav');
        const script = [
            'import json, sys',
            'from tools.tts_tool import text_to_speech_tool',
            'result = text_to_speech_tool(sys.argv[1], output_path=sys.argv[2])',
            'print(result if isinstance(result, str) else json.dumps(result, ensure_ascii=False))',
        ].join('\n');
        const { stdout } = await run(pythonCommand(), ['-c', script, text, outputPath], {
            cwd: hermesRoot(),
            env: hermesPythonEnv(),
        });
        const result = parseJson(stdout, 'Hermes TTS');
        if (!result.success || !result.file_path)
            throw new Error(result.error ?? 'Hermes TTS failed');
        if (result.file_path.toLowerCase().endsWith('.wav')) {
            return await (0, promises_1.readFile)(result.file_path);
        }
        const wavPath = path_1.default.join(dir, 'converted.wav');
        await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', result.file_path, '-ac', '1', '-ar', '24000', wavPath]);
        return await (0, promises_1.readFile)(wavPath);
    });
}
