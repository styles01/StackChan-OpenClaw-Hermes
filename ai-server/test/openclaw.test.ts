import { test } from 'node:test'
import assert from 'node:assert/strict'

import { OpenClawClient } from '../src/openclaw.ts'

// Minimal mock fetch for unit testing OpenClawClient
type FetchCall = {
    url: string
    init: RequestInit
}

function mockFetch(response: {
    status: number
    body?: string
    json?: unknown
    stream?: Array<string>
}, env: Record<string, string | undefined> = {}): { calls: FetchCall[]; restore: () => void } {
    const calls: FetchCall[] = []
    const originalFetch = globalThis.fetch
    const originalEnv = { ...process.env }

    for (const [key, value] of Object.entries(env)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
    }

    globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
        const urlString = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
        calls.push({ url: urlString, init: init ?? {} })

        if (response.status >= 400) {
            return Promise.resolve({
                ok: false,
                status: response.status,
                text: () => Promise.resolve(response.body ?? ''),
            } as Response)
        }

        if (response.stream) {
            const encoder = new TextEncoder()
            const chunks = response.stream.map(chunk => encoder.encode(chunk))
            const stream = new ReadableStream({
                start(controller) {
                    for (const chunk of chunks) controller.enqueue(chunk)
                    controller.close()
                },
            })
            return Promise.resolve({
                ok: true,
                status: response.status,
                body: stream,
                text: () => Promise.resolve(response.body ?? ''),
                json: () => Promise.resolve(response.json ?? {}),
            } as Response)
        }

        return Promise.resolve({
            ok: true,
            status: response.status,
            text: () => Promise.resolve(response.body ?? ''),
            json: () => Promise.resolve(response.json ?? {}),
        } as Response)
    }) as typeof globalThis.fetch

    return {
        calls,
        restore: () => {
            globalThis.fetch = originalFetch
            process.env = originalEnv
        },
    }
}

test('OpenClawClient submits prompt and returns content', async () => {
    const mock = mockFetch({
        status: 200,
        json: {
            choices: [{ message: { content: 'Hello from your-agent!' } }],
        },
    })

    const client = new OpenClawClient({
        host: '127.0.0.1',
        port: '18789',
        apiKey: 'test-key',
        model: 'openclaw/your-agent',
        agentId: 'your-agent',
        deviceId: 'robot-a',
    })

    const result = await client.submitPrompt('こんにちは')

    assert.equal(result, 'Hello from your-agent!')

    assert.equal(mock.calls.length, 1)
    assert.equal(mock.calls[0].url, 'http://127.0.0.1:18789/v1/chat/completions')

    const body = JSON.parse(mock.calls[0].init.body as string)
    assert.equal(body.model, 'openclaw/your-agent')
    assert.equal(body.stream, false)
    assert.equal(body.messages[0].role, 'user')
    assert.equal(body.messages[0].content, 'こんにちは')

    const headers = mock.calls[0].init.headers as Record<string, string>
    assert.equal(headers['Authorization'], 'Bearer test-key')
    assert.equal(headers['x-openclaw-session-key'], 'agent:your-agent:stackchan:robot-a')
    assert.equal(headers['Content-Type'], 'application/json')

    mock.restore()
})

test('OpenClawClient throws on 401 auth error without leaking response body', async () => {
    const mock = mockFetch({
        status: 401,
        body: 'Unauthorized: invalid API key "secret-key-123"',
    })

    const client = new OpenClawClient({
        host: '127.0.0.1',
        port: '18789',
        apiKey: 'bad-key',
    })

    await assert.rejects(
        client.submitPrompt('test'),
        (error: Error) => {
            assert.match(error.message, /HTTP 401/)
            // Critical: API key or response body must NOT leak into error message
            assert.doesNotMatch(error.message, /secret-key-123/)
            return true
        },
    )

    mock.restore()
})

test('OpenClawClient throws on 500 server error', async () => {
    const mock = mockFetch({
        status: 500,
        body: 'Internal Server Error',
    })

    const client = new OpenClawClient({
        host: '127.0.0.1',
        port: '18789',
        apiKey: 'test-key',
    })

    await assert.rejects(
        client.submitPrompt('test'),
        /OpenClaw request failed: HTTP 500/,
    )

    mock.restore()
})

test('OpenClawClient throws when response has no content', async () => {
    const mock = mockFetch({
        status: 200,
        json: { choices: [{ message: {} }] },
    })

    const client = new OpenClawClient({
        host: '127.0.0.1',
        port: '18789',
        apiKey: 'test-key',
    })

    await assert.rejects(
        client.submitPrompt('test'),
        /OpenClaw returned no content/,
    )

    mock.restore()
})

test('OpenClawClient throws on API error in response body', async () => {
    const mock = mockFetch({
        status: 200,
        json: {
            error: { message: 'Agent not found' },
        },
    })

    const client = new OpenClawClient({
        host: '127.0.0.1',
        port: '18789',
        apiKey: 'test-key',
    })

    await assert.rejects(
        client.submitPrompt('test'),
        /OpenClaw error: Agent not found/,
    )

    mock.restore()
})

test('OpenClawClient streamPrompt yields delta and complete events with full text', async () => {
    const sseLines = [
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n',
        'data: {"choices":[{"delta":{"content":" world"}}]}\n',
        'data: [DONE]\n',
    ]

    const mock = mockFetch({
        status: 200,
        stream: sseLines,
    })

    const client = new OpenClawClient({
        host: '127.0.0.1',
        port: '18789',
        apiKey: 'test-key',
    })

    const events: Array<{ type: string; text?: string }> = []
    for await (const event of client.streamPrompt('test')) {
        events.push(event)
    }

    assert.equal(events.length, 3)
    assert.equal(events[0].type, 'delta')
    assert.equal(events[0].text, 'Hello')
    assert.equal(events[1].type, 'delta')
    assert.equal(events[1].text, ' world')
    assert.equal(events[2].type, 'complete')
    // Critical fix: complete event must carry accumulated full text
    assert.equal(events[2].text, 'Hello world')

    mock.restore()
})

test('OpenClawClient streamPrompt handles stream ending without [DONE]', async () => {
    // Stream ends abruptly — should still emit complete with accumulated text
    const sseLines = [
        'data: {"choices":[{"delta":{"content":"Partial"}}]}\n',
        'data: {"choices":[{"delta":{"content":" reply"}}]}\n',
        // No [DONE] — stream just ends
    ]

    const mock = mockFetch({
        status: 200,
        stream: sseLines,
    })

    const client = new OpenClawClient({
        host: '127.0.0.1',
        port: '18789',
        apiKey: 'test-key',
    })

    const events: Array<{ type: string; text?: string }> = []
    for await (const event of client.streamPrompt('test')) {
        events.push(event)
    }

    // Should get 2 deltas + 1 complete (no [DONE] path)
    assert.equal(events.length, 3)
    assert.equal(events[0].type, 'delta')
    assert.equal(events[0].text, 'Partial')
    assert.equal(events[1].type, 'delta')
    assert.equal(events[1].text, ' reply')
    assert.equal(events[2].type, 'complete')
    assert.equal(events[2].text, 'Partial reply')

    mock.restore()
})

test('OpenClawClient streamPrompt handles data: without space prefix', async () => {
    // SSE spec allows "data:" without space
    const sseLines = [
        'data:{"choices":[{"delta":{"content":"Hi"}}]}\n',
        'data: [DONE]\n',
    ]

    const mock = mockFetch({
        status: 200,
        stream: sseLines,
    })

    const client = new OpenClawClient({
        host: '127.0.0.1',
        port: '18789',
        apiKey: 'test-key',
    })

    const events: Array<{ type: string; text?: string }> = []
    for await (const event of client.streamPrompt('test')) {
        events.push(event)
    }

    assert.equal(events.length, 2)
    assert.equal(events[0].type, 'delta')
    assert.equal(events[0].text, 'Hi')
    assert.equal(events[1].type, 'complete')
    assert.equal(events[1].text, 'Hi')

    mock.restore()
})

test('OpenClawClient streamPrompt handles partial SSE lines split across chunks', async () => {
    // Simulate a line split across two chunks
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
        start(controller) {
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hel'))
            controller.enqueue(encoder.encode('lo"}}]}\n'))
            controller.enqueue(encoder.encode('data: [DONE]\n'))
            controller.close()
        },
    })

    const originalFetch = globalThis.fetch
    globalThis.fetch = (() => {
        return Promise.resolve({
            ok: true,
            status: 200,
            body: stream,
        } as Response)
    }) as typeof globalThis.fetch

    const client = new OpenClawClient({
        host: '127.0.0.1',
        port: '18789',
        apiKey: 'test-key',
    })

    const events: Array<{ type: string; text?: string }> = []
    for await (const event of client.streamPrompt('test')) {
        events.push(event)
    }

    assert.equal(events.length, 2)
    assert.equal(events[0].type, 'delta')
    assert.equal(events[0].text, 'Hello')
    assert.equal(events[1].type, 'complete')
    assert.equal(events[1].text, 'Hello')

    globalThis.fetch = originalFetch
})

test('OpenClawClient streamPrompt skips malformed JSON lines', async () => {
    const sseLines = [
        'data: {broken json}\n',
        'data: {"choices":[{"delta":{"content":"good"}}]}\n',
        'data: [DONE]\n',
    ]

    const mock = mockFetch({
        status: 200,
        stream: sseLines,
    })

    const client = new OpenClawClient({
        host: '127.0.0.1',
        port: '18789',
        apiKey: 'test-key',
    })

    const events: Array<{ type: string; text?: string }> = []
    for await (const event of client.streamPrompt('test')) {
        events.push(event)
    }

    // Malformed line skipped, good line processed, [DONE] → complete
    assert.equal(events.length, 2)
    assert.equal(events[0].type, 'delta')
    assert.equal(events[0].text, 'good')
    assert.equal(events[1].type, 'complete')
    assert.equal(events[1].text, 'good')

    mock.restore()
})

test('OpenClawClient interrupt aborts in-flight request', async () => {
    const originalFetch = globalThis.fetch

    globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
            const signal = init?.signal as AbortSignal
            if (signal) {
                signal.addEventListener('abort', () => {
                    reject(new DOMException('Aborted', 'AbortError'))
                })
            }
        })
    }) as typeof globalThis.fetch

    const client = new OpenClawClient({
        host: '127.0.0.1',
        port: '18789',
        apiKey: 'test-key',
    })

    const promptPromise = client.submitPrompt('test')

    await client.interrupt()

    await assert.rejects(
        promptPromise,
        (error: Error) => error.name === 'AbortError' || error.message.includes('Aborted'),
    )

    globalThis.fetch = originalFetch
})

test('OpenClawClient uses env vars as defaults', async () => {
    const mock = mockFetch({
        status: 200,
        json: { choices: [{ message: { content: 'ok' } }] },
    })

    process.env.OPENCLAW_HOST = '10.0.0.5'
    process.env.OPENCLAW_PORT = '9999'
    process.env.OPENCLAW_API_KEY = 'env-key'
    process.env.OPENCLAW_MODEL = 'openclaw/dex'
    process.env.OPENCLAW_AGENT_ID = 'dex'
    process.env.STACKCHAN_DEVICE_ID = 'robot-b'

    const client = new OpenClawClient()

    await client.submitPrompt('test')

    assert.equal(mock.calls[0].url, 'http://10.0.0.5:9999/v1/chat/completions')
    const headers = mock.calls[0].init.headers as Record<string, string>
    assert.equal(headers['Authorization'], 'Bearer env-key')
    assert.equal(headers['x-openclaw-session-key'], 'agent:dex:stackchan:robot-b')

    const body = JSON.parse(mock.calls[0].init.body as string)
    assert.equal(body.model, 'openclaw/dex')

    mock.restore()

    delete process.env.OPENCLAW_HOST
    delete process.env.OPENCLAW_PORT
    delete process.env.OPENCLAW_API_KEY
    delete process.env.OPENCLAW_MODEL
    delete process.env.OPENCLAW_AGENT_ID
    delete process.env.STACKCHAN_DEVICE_ID
})

test('OpenClawClient dispose aborts in-flight request', async () => {
    const originalFetch = globalThis.fetch

    globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
            const signal = init?.signal as AbortSignal
            if (signal) {
                signal.addEventListener('abort', () => {
                    reject(new DOMException('Aborted', 'AbortError'))
                })
            }
        })
    }) as typeof globalThis.fetch

    const client = new OpenClawClient({
        host: '127.0.0.1',
        port: '18789',
        apiKey: 'test-key',
    })

    const promptPromise = client.submitPrompt('test')

    await client.dispose()

    await assert.rejects(
        promptPromise,
        (error: Error) => error.name === 'AbortError' || error.message.includes('Aborted'),
    )

    globalThis.fetch = originalFetch
})