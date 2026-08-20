"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OpenClawClient = void 0;
class OpenClawClient {
    controller = null;
    baseUrl;
    apiKey;
    model;
    sessionKey;
    constructor(options) {
        const host = options?.host ?? process.env.OPENCLAW_HOST ?? '127.0.0.1';
        const port = options?.port ?? process.env.OPENCLAW_PORT ?? '18789';
        this.baseUrl = `http://${host}:${port}`;
        this.apiKey = options?.apiKey ?? process.env.OPENCLAW_API_KEY ?? '';
        this.model = options?.model ?? process.env.OPENCLAW_MODEL ?? 'openclaw/your-agent';
        const agentId = options?.agentId ?? process.env.OPENCLAW_AGENT_ID ?? 'your-agent';
        const deviceId = options?.deviceId ?? process.env.STACKCHAN_DEVICE_ID ?? 'default';
        this.sessionKey = `agent:${agentId}:stackchan:${deviceId}`;
    }
    async submitPrompt(prompt) {
        this.controller = new AbortController();
        const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`,
                'x-openclaw-session-key': this.sessionKey,
            },
            body: JSON.stringify({
                model: this.model,
                stream: false,
                messages: [{ role: 'user', content: prompt }],
            }),
            signal: this.controller.signal,
        });
        if (!response.ok) {
            throw new Error(`OpenClaw request failed: HTTP ${response.status}`);
        }
        const data = await response.json();
        if (data.error) {
            throw new Error(`OpenClaw error: ${data.error.message ?? 'unknown error'}`);
        }
        const content = data?.choices?.[0]?.message?.content;
        if (typeof content !== 'string')
            throw new Error('OpenClaw returned no content');
        return content;
    }
    async *streamPrompt(prompt) {
        this.controller = new AbortController();
        const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`,
                'x-openclaw-session-key': this.sessionKey,
            },
            body: JSON.stringify({
                model: this.model,
                stream: true,
                messages: [{ role: 'user', content: prompt }],
            }),
            signal: this.controller.signal,
        });
        if (!response.ok) {
            throw new Error(`OpenClaw request failed: HTTP ${response.status}`);
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let fullText = '';
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() ?? '';
                for (const line of lines) {
                    // Accept both "data: " and "data:" prefixes (SSE spec allows both)
                    const trimmed = line.trim();
                    if (!trimmed.startsWith('data:'))
                        continue;
                    const data = trimmed.slice(5).trim();
                    if (data === '[DONE]') {
                        yield { type: 'complete', text: fullText };
                        return;
                    }
                    try {
                        const json = JSON.parse(data);
                        const delta = json?.choices?.[0]?.delta?.content;
                        if (typeof delta === 'string' && delta) {
                            fullText += delta;
                            yield { type: 'delta', text: delta };
                        }
                    }
                    catch {
                        // skip malformed SSE lines
                    }
                }
            }
            // Stream ended without [DONE] — emit complete with accumulated text
            yield { type: 'complete', text: fullText };
        }
        catch (error) {
            if (error instanceof Error && error.name === 'AbortError')
                return;
            throw error;
        }
    }
    async interrupt() {
        this.controller?.abort();
    }
    async dispose() {
        this.controller?.abort();
    }
}
exports.OpenClawClient = OpenClawClient;
