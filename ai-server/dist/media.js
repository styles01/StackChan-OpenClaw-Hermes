"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.setObservedMediaBaseUrl = setObservedMediaBaseUrl;
exports.registerMediaFile = registerMediaFile;
exports.resolveDisplayImageSource = resolveDisplayImageSource;
exports.extractFirstDisplayImage = extractFirstDisplayImage;
exports.stripMediaForSpeech = stripMediaForSpeech;
exports.serveMediaRequest = serveMediaRequest;
const crypto_1 = __importDefault(require("crypto"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const MEDIA_TTL_MS = Number(process.env.STACKCHAN_MEDIA_TTL_MS ?? 10 * 60 * 1000);
const MAX_MEDIA_FILE_BYTES = Number(process.env.STACKCHAN_MEDIA_MAX_BYTES ?? 5 * 1024 * 1024);
const mediaEntries = new Map();
let observedBaseUrl = null;
function configuredBaseUrl() {
    const value = process.env.STACKCHAN_PUBLIC_BASE_URL?.trim();
    return value ? value.replace(/\/+$/, '') : null;
}
function publicBaseUrl() {
    return configuredBaseUrl() ?? observedBaseUrl ?? `http://127.0.0.1:${process.env.PORT ?? '8765'}`;
}
function cleanSource(source) {
    return source.trim().replace(/^<|>$/g, '').replace(/^['"`]|['"`]$/g, '').replace(/[),.。]+$/u, '');
}
function mimeTypeForFile(filePath) {
    const ext = path_1.default.extname(filePath).toLowerCase();
    if (ext === '.jpg' || ext === '.jpeg')
        return 'image/jpeg';
    if (ext === '.png')
        return 'image/png';
    return null;
}
function isHttpUrl(source) {
    return /^https?:\/\//i.test(source);
}
function filePathFromSource(source) {
    if (source.startsWith('file://')) {
        try {
            return new URL(source).pathname;
        }
        catch {
            return null;
        }
    }
    return path_1.default.isAbsolute(source) ? source : null;
}
function setObservedMediaBaseUrl(baseUrl) {
    if (configuredBaseUrl())
        return;
    observedBaseUrl = baseUrl.replace(/\/+$/, '');
}
function registerMediaFile(filePath) {
    const resolved = path_1.default.resolve(filePath);
    const mimeType = mimeTypeForFile(resolved);
    if (!mimeType) {
        throw new Error(`Unsupported image type for StackChan display: ${resolved}`);
    }
    const stats = fs_1.default.statSync(resolved);
    if (!stats.isFile())
        throw new Error(`Media path is not a file: ${resolved}`);
    if (stats.size > MAX_MEDIA_FILE_BYTES) {
        throw new Error(`Media file is too large for StackChan display: ${resolved}`);
    }
    const id = crypto_1.default.randomUUID();
    mediaEntries.set(id, {
        filePath: resolved,
        mimeType,
        expiresAt: Date.now() + MEDIA_TTL_MS,
    });
    return `${publicBaseUrl()}/media/${id}`;
}
function resolveDisplayImageSource(source) {
    const cleaned = cleanSource(source).replace(/^MEDIA:\s*/iu, '');
    if (!cleaned)
        return null;
    if (isHttpUrl(cleaned))
        return cleaned;
    const filePath = filePathFromSource(cleaned);
    return filePath ? registerMediaFile(filePath) : null;
}
function extractFirstDisplayImage(text) {
    const mediaMatch = text.match(/MEDIA:\s*(\S+)/u);
    if (mediaMatch?.[1])
        return cleanSource(mediaMatch[1]);
    const markdownMatch = text.match(/!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/u);
    if (markdownMatch?.[1])
        return cleanSource(markdownMatch[1]);
    return null;
}
function stripMediaForSpeech(text) {
    return text
        .replace(/!\[[^\]]*\]\([^)]+\)/gu, '')
        .replace(/MEDIA:\s*\S+/gu, '')
        .replace(/[ \t]+/gu, ' ')
        .replace(/\n{3,}/gu, '\n\n')
        .trim();
}
function serveMediaRequest(req, res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (!url.pathname.startsWith('/media/'))
        return false;
    const id = decodeURIComponent(url.pathname.slice('/media/'.length));
    const entry = mediaEntries.get(id);
    if (!entry || entry.expiresAt < Date.now()) {
        if (entry)
            mediaEntries.delete(id);
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('media not found');
        return true;
    }
    const stream = fs_1.default.createReadStream(entry.filePath);
    stream.on('error', () => {
        mediaEntries.delete(id);
        if (!res.headersSent)
            res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('media not found');
    });
    res.writeHead(200, {
        'content-type': entry.mimeType,
        'cache-control': 'no-store',
    });
    stream.pipe(res);
    return true;
}
