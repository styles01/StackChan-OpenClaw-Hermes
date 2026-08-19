// device_config.ts — Per-device backend binding
// Reads devices.json and provides lookup by Device-Id (MAC address)
import { readFileSync } from 'fs'
import { resolve } from 'path'

// Avoid import.meta.url (requires ES2020+ module setting)
// Use process.cwd() relative resolution instead

export type Backend = 'openclaw' | 'hermes'

export interface DeviceBinding {
    backend: Backend
    agent_id: string
    label?: string
}

export interface DeviceConfig {
    default: DeviceBinding
    devices: Record<string, DeviceBinding>
}

let cachedConfig: DeviceConfig | null = null

function loadConfig(): DeviceConfig {
    if (cachedConfig) return cachedConfig
    
    // Try multiple locations: CWD, ai-server/, and relative to this file
    const candidates = [
        resolve(process.cwd(), 'devices.json'),
        resolve(process.cwd(), 'ai-server', 'devices.json'),
    ]
    const configPath = candidates.find(p => { try { readFileSync(p, 'utf-8'); return true } catch { return false } }) ?? candidates[0]
    try {
        const raw = readFileSync(configPath, 'utf-8')
        cachedConfig = JSON.parse(raw) as DeviceConfig
    } catch {
        // Fallback: default to OpenClaw + rosie
        cachedConfig = {
            default: { backend: 'openclaw' as Backend, agent_id: 'rosie' },
            devices: {}
        }
    }
    return cachedConfig
}

export function getDeviceBinding(deviceId: string | undefined): DeviceBinding {
    const config = loadConfig()
    
    if (deviceId && config.devices[deviceId]) {
        return config.devices[deviceId]
    }
    
    return config.default
}

// Hot-reload config (for when devices.json is edited without restart)
export function reloadConfig(): void {
    cachedConfig = null
    loadConfig()
}

// NOTE: agent_id is currently only used by the OpenClaw backend.
// HermesClient connects to a global HERMES_DASHBOARD_URL and does not
// support per-device agent routing. The agent_id field in devices.json
// is ignored for Hermes-bound devices (documented limitation).