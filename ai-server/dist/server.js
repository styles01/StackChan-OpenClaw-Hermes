"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startServer = startServer;
const http_1 = __importDefault(require("http"));
const ws_1 = require("ws");
const session_js_1 = require("./session.js");
const media_js_1 = require("./media.js");
const device_config_js_1 = require("./device_config.js");
const DEVICE_KEEPALIVE_INTERVAL_MS = Math.max(1000, Number(process.env.STACKCHAN_WS_KEEPALIVE_MS ?? '3000') || 3000);
function startServer(port) {
    const server = http_1.default.createServer((req, res) => {
        if ((0, media_js_1.serveMediaRequest)(req, res))
            return;
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('not found');
    });
    const wss = new ws_1.WebSocketServer({ server, path: '/ws' });
    // Default 0.0.0.0 so ESP32 devices on WiFi can reach the server.
    // Set STACKCHAN_WS_HOST=127.0.0.1 for local-only/testing if no hardware is connected.
    const host = process.env.STACKCHAN_WS_HOST ?? '0.0.0.0';
    server.on('listening', () => {
        console.log(`[server] WebSocket server listening on ws://${host}:${port}/ws`);
        console.log(`[server] Media server listening on http://${host}:${port}/media/...`);
    });
    wss.on('connection', (ws, req) => {
        const ip = req.socket.remoteAddress ?? 'unknown';
        if (req.headers.host) {
            (0, media_js_1.setObservedMediaBaseUrl)(`http://${req.headers.host}`);
        }
        // Read Device-Id from WS handshake headers (firmware sends MAC address)
        const deviceId = req.headers['device-id'];
        const binding = (0, device_config_js_1.getDeviceBinding)(deviceId);
        console.log(`[server] connected: ${ip} device=${deviceId ?? 'unknown'} backend=${binding.backend} agent=${binding.agent_id}`);
        const session = new session_js_1.Session(ws, { deviceBinding: binding, deviceId });
        const keepaliveTimer = setInterval(() => {
            if (ws.readyState !== ws_1.WebSocket.OPEN)
                return;
            try {
                ws.ping();
            }
            catch {
                // The close handler will clean up the session.
            }
        }, DEVICE_KEEPALIVE_INTERVAL_MS);
        ws.on('message', (data) => {
            session.handleMessage(data);
        });
        ws.on('close', () => {
            clearInterval(keepaliveTimer);
            console.log(`[server] disconnected: ${ip}`);
            session.close();
        });
        ws.on('error', (err) => {
            console.error(`[server] error from ${ip}:`, err.message);
        });
    });
    server.listen(port, host);
}
