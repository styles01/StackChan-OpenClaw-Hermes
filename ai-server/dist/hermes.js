"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.HermesClient = exports.DashboardWsHermesClient = exports.StdioHermesClient = void 0;
exports.isLocalDashboardUrl = isLocalDashboardUrl;
exports.assertLocalDashboardUrlAllowed = assertLocalDashboardUrlAllowed;
exports.extractDashboardSessionToken = extractDashboardSessionToken;
const child_process_1 = require("child_process");
const readline_1 = require("readline");
const path_1 = __importDefault(require("path"));
const fs_1 = require("fs");
const ws_1 = __importDefault(require("ws"));
const DEFAULT_RPC_TIMEOUT_MS = 30_000;
const DEFAULT_TURN_TIMEOUT_MS = 600_000;
const DEFAULT_DASHBOARD_URL = 'http://127.0.0.1:9119';
const LOCAL_DASHBOARD_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'host.docker.internal']);
function defaultHermesRoot() {
    if (process.env.HERMES_ROOT)
        return process.env.HERMES_ROOT;
    const fromAiServer = path_1.default.resolve(process.cwd(), '..', 'hermes-agent');
    if ((0, fs_1.existsSync)(path_1.default.join(fromAiServer, 'tui_gateway', 'entry.py')))
        return fromAiServer;
    return path_1.default.resolve(process.cwd(), 'hermes-agent');
}
function isRecord(value) {
    return typeof value === 'object' && value !== null;
}
function eventFromEnvelope(value) {
    if (!isRecord(value))
        return null;
    if (value['method'] === 'event' && isRecord(value['params'])) {
        return value['params'];
    }
    if (typeof value['type'] === 'string') {
        return value;
    }
    return null;
}
function errorFromJsonRpc(error) {
    if (isRecord(error) && typeof error['message'] === 'string') {
        return new Error(error['message']);
    }
    return new Error(JSON.stringify(error));
}
function eventText(event) {
    if (typeof event.text === 'string')
        return event.text;
    if (isRecord(event.payload) && typeof event.payload['text'] === 'string')
        return event.payload['text'];
    return null;
}
function dashboardWebSocketUrl(dashboardUrl, token) {
    const url = new URL(dashboardUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = '/api/ws';
    url.search = '';
    url.searchParams.set('token', token);
    return url.toString();
}
function isTruthyEnv(value) {
    return value !== undefined && /^(1|true|yes|on)$/i.test(value.trim());
}
function isLocalDashboardUrl(dashboardUrl) {
    try {
        const url = new URL(dashboardUrl);
        const hostname = url.hostname.replace(/^\[|\]$/g, '');
        return LOCAL_DASHBOARD_HOSTS.has(hostname);
    }
    catch {
        return false;
    }
}
function assertLocalDashboardUrlAllowed(dashboardUrl) {
    if (!isTruthyEnv(process.env.STACKCHAN_LOCAL_ONLY))
        return;
    if (isLocalDashboardUrl(dashboardUrl))
        return;
    throw new Error(`STACKCHAN_LOCAL_ONLY=true requires HERMES_DASHBOARD_URL to use localhost, 127.0.0.1, ::1, or host.docker.internal; got ${dashboardUrl}`);
}
function extractDashboardSessionToken(html) {
    const match = html.match(/window\.__HERMES_SESSION_TOKEN__\s*=\s*(['"])(.*?)\1/);
    return match?.[2] ?? null;
}
class StdioHermesTransport {
    process;
    async start(onLine, onClose) {
        if (this.process && !this.process.killed)
            return;
        const hermesRoot = defaultHermesRoot();
        const python = process.env.HERMES_PYTHON ?? 'python3';
        const env = {
            ...process.env,
            PYTHONPATH: [hermesRoot, process.env.PYTHONPATH].filter(Boolean).join(path_1.default.delimiter),
        };
        this.process = (0, child_process_1.spawn)(python, ['-m', 'tui_gateway.entry'], {
            cwd: hermesRoot,
            env,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        const stdout = (0, readline_1.createInterface)({ input: this.process.stdout });
        stdout.on('line', onLine);
        this.process.stderr.on('data', (chunk) => {
            const text = chunk.toString('utf8').trim();
            if (text)
                console.error(`[hermes] ${text}`);
        });
        this.process.on('exit', (code, signal) => {
            console.error(`[hermes] gateway exited code=${code} signal=${signal}`);
            this.process = undefined;
            onClose(new Error('Hermes gateway exited'));
        });
    }
    async sendLine(line) {
        if (!this.process || this.process.killed) {
            throw new Error('Hermes stdio gateway is not running');
        }
        await new Promise((resolve, reject) => {
            this.process?.stdin.write(`${line}\n`, (error) => {
                if (error)
                    reject(error);
                else
                    resolve();
            });
        });
    }
    async dispose() {
        this.process?.kill();
        this.process = undefined;
    }
}
class DashboardWsTransport {
    dashboardUrl;
    explicitToken;
    socket;
    constructor(dashboardUrl = process.env.HERMES_DASHBOARD_URL ?? DEFAULT_DASHBOARD_URL, explicitToken = process.env.HERMES_DASHBOARD_TOKEN) {
        this.dashboardUrl = dashboardUrl;
        this.explicitToken = explicitToken;
    }
    async start(onLine, onClose) {
        if (this.socket?.readyState === ws_1.default.OPEN)
            return;
        assertLocalDashboardUrlAllowed(this.dashboardUrl);
        const token = this.explicitToken ?? await this.fetchSessionToken();
        const wsUrl = dashboardWebSocketUrl(this.dashboardUrl, token);
        await new Promise((resolve, reject) => {
            let opened = false;
            const socket = new ws_1.default(wsUrl);
            this.socket = socket;
            socket.on('open', () => {
                opened = true;
                resolve();
            });
            socket.on('message', (data) => {
                const text = data.toString('utf8');
                for (const line of text.split(/\r?\n/)) {
                    if (line.trim())
                        onLine(line);
                }
            });
            socket.on('error', (error) => {
                if (!opened)
                    reject(error);
                else
                    onClose(error instanceof Error ? error : new Error(String(error)));
            });
            socket.on('close', (code, reason) => {
                this.socket = undefined;
                const message = code === 4403
                    ? 'Hermes Dashboard /api/ws rejected the connection. Start Hermes with dashboard --tui so /api/ws is enabled.'
                    : `Hermes Dashboard WebSocket closed code=${code} reason=${reason.toString('utf8')}`;
                const error = new Error(message);
                if (!opened)
                    reject(error);
                else
                    onClose(error);
            });
        });
    }
    async sendLine(line) {
        if (this.socket?.readyState !== ws_1.default.OPEN) {
            throw new Error('Hermes Dashboard WebSocket is not connected');
        }
        await new Promise((resolve, reject) => {
            this.socket?.send(`${line}\n`, (error) => {
                if (error)
                    reject(error);
                else
                    resolve();
            });
        });
    }
    async dispose() {
        const socket = this.socket;
        this.socket = undefined;
        if (!socket || socket.readyState === ws_1.default.CLOSED)
            return;
        await new Promise((resolve) => {
            socket.once('close', () => resolve());
            socket.close();
        });
    }
    async fetchSessionToken() {
        assertLocalDashboardUrlAllowed(this.dashboardUrl);
        let response;
        try {
            response = await fetch(this.dashboardUrl);
        }
        catch (error) {
            throw new Error(`Failed to fetch Hermes Dashboard HTML from ${this.dashboardUrl}: ${String(error)}`);
        }
        if (!response.ok) {
            throw new Error(`Failed to fetch Hermes Dashboard HTML from ${this.dashboardUrl}: HTTP ${response.status}`);
        }
        const html = await response.text();
        const token = extractDashboardSessionToken(html);
        if (!token) {
            throw new Error('Hermes Dashboard HTML did not contain window.__HERMES_SESSION_TOKEN__. Start Hermes with dashboard --tui or set HERMES_DASHBOARD_TOKEN.');
        }
        return token;
    }
}
class RpcHermesClient {
    transport;
    nextId = 1;
    sessionId;
    started = false;
    disposed = false;
    pending = new Map();
    listeners = new Set();
    closeListeners = new Set();
    constructor(transport) {
        this.transport = transport;
    }
    async submitPrompt(prompt) {
        const sessionId = await this.ensureSession();
        const turnTimeoutMs = Number(process.env.HERMES_TURN_TIMEOUT_MS ?? DEFAULT_TURN_TIMEOUT_MS);
        return await new Promise((resolve, reject) => {
            let complete = false;
            const fragments = [];
            const timer = setTimeout(() => {
                cleanup();
                reject(new Error(`Hermes prompt timed out after ${turnTimeoutMs}ms`));
            }, turnTimeoutMs);
            const cleanup = () => {
                clearTimeout(timer);
                this.listeners.delete(onEvent);
                this.closeListeners.delete(onClose);
            };
            const onClose = (error) => {
                cleanup();
                reject(error);
            };
            const onEvent = (event) => {
                const text = eventText(event);
                if (event.type === 'message.delta' && text !== null) {
                    if (event.session_id !== sessionId)
                        return;
                    fragments.push(text);
                }
                if (event.type === 'message.complete') {
                    if (event.session_id !== sessionId)
                        return;
                    complete = true;
                    cleanup();
                    resolve(text ?? fragments.join(''));
                }
            };
            this.listeners.add(onEvent);
            this.closeListeners.add(onClose);
            this.request('prompt.submit', { session_id: sessionId, text: prompt })
                .then(() => {
                if (!complete)
                    return;
            })
                .catch((error) => {
                cleanup();
                reject(error);
            });
        });
    }
    async *streamPrompt(prompt) {
        const sessionId = await this.ensureSession();
        const turnTimeoutMs = Number(process.env.HERMES_TURN_TIMEOUT_MS ?? DEFAULT_TURN_TIMEOUT_MS);
        const queue = [];
        let done = false;
        let failure;
        let wake;
        const notify = () => {
            wake?.();
            wake = undefined;
        };
        const timer = setTimeout(() => {
            failure = new Error(`Hermes prompt timed out after ${turnTimeoutMs}ms`);
            done = true;
            cleanup();
            notify();
        }, turnTimeoutMs);
        const cleanup = () => {
            clearTimeout(timer);
            this.listeners.delete(onEvent);
            this.closeListeners.delete(onClose);
        };
        const onClose = (error) => {
            failure = error;
            done = true;
            cleanup();
            notify();
        };
        const onEvent = (event) => {
            if (event.session_id !== sessionId)
                return;
            const text = eventText(event);
            if (event.type === 'message.delta' && text !== null) {
                queue.push({ type: 'delta', text });
                notify();
                return;
            }
            if (event.type === 'message.complete') {
                done = true;
                queue.push({
                    type: 'complete',
                    text: text ?? undefined,
                });
                cleanup();
                notify();
            }
        };
        this.listeners.add(onEvent);
        this.closeListeners.add(onClose);
        this.request('prompt.submit', { session_id: sessionId, text: prompt })
            .catch((error) => {
            failure = error instanceof Error ? error : new Error(String(error));
            done = true;
            cleanup();
            notify();
        });
        try {
            while (!done || queue.length > 0) {
                if (queue.length > 0) {
                    yield queue.shift();
                    continue;
                }
                if (failure)
                    throw failure;
                await new Promise((resolve) => {
                    wake = resolve;
                });
            }
            if (failure)
                throw failure;
        }
        finally {
            cleanup();
        }
    }
    async interrupt() {
        if (!this.sessionId)
            return;
        await this.request('session.interrupt', { session_id: this.sessionId }).then(() => undefined);
    }
    async dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        const error = new Error('Hermes client disposed');
        for (const [id, pending] of this.pending) {
            clearTimeout(pending.timer);
            pending.reject(error);
            this.pending.delete(id);
        }
        for (const listener of [...this.closeListeners]) {
            listener(error);
        }
        this.closeListeners.clear();
        this.listeners.clear();
        await this.transport.dispose();
    }
    async ensureSession() {
        if (this.sessionId)
            return this.sessionId;
        const result = await this.request('session.create', {});
        if (!isRecord(result) || typeof result['session_id'] !== 'string') {
            throw new Error('Hermes session.create returned no session_id');
        }
        this.sessionId = result['session_id'];
        return this.sessionId;
    }
    async request(method, params, timeoutMs = DEFAULT_RPC_TIMEOUT_MS) {
        await this.ensureTransport();
        const id = this.nextId++;
        const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
        return await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Hermes RPC ${method} timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            this.transport.sendLine(payload).catch((error) => {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(error);
            });
        });
    }
    async ensureTransport() {
        if (this.disposed)
            throw new Error('Hermes client disposed');
        if (this.started)
            return;
        await this.transport.start((line) => this.handleLine(line), (error) => this.handleClose(error));
        this.started = true;
    }
    handleClose(error) {
        if (this.disposed)
            return;
        this.started = false;
        this.sessionId = undefined;
        for (const [id, pending] of this.pending) {
            clearTimeout(pending.timer);
            pending.reject(error);
            this.pending.delete(id);
        }
        for (const listener of [...this.closeListeners]) {
            listener(error);
        }
    }
    handleLine(line) {
        if (!line.trim())
            return;
        let parsed;
        try {
            parsed = JSON.parse(line);
        }
        catch {
            console.error(`[hermes] non-json message: ${line}`);
            return;
        }
        const response = parsed;
        if (typeof response.id === 'number') {
            const pending = this.pending.get(response.id);
            if (!pending)
                return;
            clearTimeout(pending.timer);
            this.pending.delete(response.id);
            if (response.error)
                pending.reject(errorFromJsonRpc(response.error));
            else
                pending.resolve(response.result);
            return;
        }
        const event = eventFromEnvelope(parsed);
        if (!event)
            return;
        for (const listener of [...this.listeners]) {
            listener(event);
        }
    }
}
class StdioHermesClient extends RpcHermesClient {
    constructor() {
        super(new StdioHermesTransport());
    }
}
exports.StdioHermesClient = StdioHermesClient;
class DashboardWsHermesClient extends RpcHermesClient {
    constructor(dashboardUrl, token) {
        super(new DashboardWsTransport(dashboardUrl, token));
    }
}
exports.DashboardWsHermesClient = DashboardWsHermesClient;
class HermesClient {
    client;
    constructor() {
        this.client = process.env.HERMES_CONNECT_MODE === 'dashboard_ws'
            ? new DashboardWsHermesClient()
            : new StdioHermesClient();
    }
    async submitPrompt(prompt) {
        return await this.client.submitPrompt(prompt);
    }
    async *streamPrompt(prompt) {
        yield* this.client.streamPrompt(prompt);
    }
    async interrupt() {
        await this.client.interrupt();
    }
    async dispose() {
        await this.client.dispose();
    }
}
exports.HermesClient = HermesClient;
