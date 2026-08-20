"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDeviceBinding = getDeviceBinding;
exports.reloadConfig = reloadConfig;
// device_config.ts — Per-device backend binding
// Reads devices.json and provides lookup by Device-Id (MAC address)
const fs_1 = require("fs");
const path_1 = require("path");
let cachedConfig = null;
function loadConfig() {
    if (cachedConfig)
        return cachedConfig;
    // Try multiple locations: CWD, ai-server/, and relative to this file
    const candidates = [
        (0, path_1.resolve)(process.cwd(), 'devices.json'),
        (0, path_1.resolve)(process.cwd(), 'ai-server', 'devices.json'),
    ];
    const configPath = candidates.find(p => { try {
        (0, fs_1.readFileSync)(p, 'utf-8');
        return true;
    }
    catch {
        return false;
    } }) ?? candidates[0];
    try {
        const raw = (0, fs_1.readFileSync)(configPath, 'utf-8');
        cachedConfig = JSON.parse(raw);
    }
    catch {
        // Fallback: default to OpenClaw + your-agent
        cachedConfig = {
            default: { backend: 'openclaw', agent_id: 'your-agent' },
            devices: {}
        };
    }
    return cachedConfig;
}
function getDeviceBinding(deviceId) {
    const config = loadConfig();
    if (deviceId && config.devices[deviceId]) {
        return config.devices[deviceId];
    }
    return config.default;
}
// Hot-reload config (for when devices.json is edited without restart)
function reloadConfig() {
    cachedConfig = null;
    loadConfig();
}
// NOTE: agent_id is currently only used by the OpenClaw backend.
// HermesClient connects to a global HERMES_DASHBOARD_URL and does not
// support per-device agent routing. The agent_id field in devices.json
// is ignored for Hermes-bound devices (documented limitation).
