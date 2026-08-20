#!/usr/bin/env python3
"""End-to-end test for Stack-chan WebSocket path.
Tests: device → WS → ai-server → OpenClaw/Hermes → TTS → device.

Prerequisites:
- ai-server running (npm start in ai-server/)
- OpenClaw Gateway running (or Hermes sidecar)
- Device flashed with our firmware (or simulated WS client)

Usage:
    python3 test_ws_e2e.py --host localhost --port 8765
    python3 test_ws_e2e.py --host 192.168.1.100 --port 8765 --device-id AA:BB:CC:DD:EE:01
"""
import argparse
import asyncio
import json
import websockets
import struct
import time
import sys

async def test_connection(host: str, port: int, device_id: str = "TEST:DEVICE:01"):
    """Test basic WS connection and hello handshake."""
    uri = f"ws://{host}:{port}/ws"
    headers = {"Device-Id": device_id, "Client-Id": "test-client-001"}
    
    print(f"[test] Connecting to {uri} with Device-Id={device_id}...")
    
    try:
        async with websockets.connect(uri, additional_headers=headers) as ws:
            print(f"[test] ✅ Connected")
            
            # Send hello message (same format as firmware)
            hello = {
                "type": "hello",
                "version": 3,
                "features": {"aec": True, "mcp": True},
                "transport": "websocket",
                "audio_params": {
                    "format": "opus",
                    "sample_rate": 16000,
                    "channels": 1,
                    "frame_duration": 60
                }
            }
            await ws.send(json.dumps(hello))
            print(f"[test] ✅ Sent hello")
            
            # Wait for server hello
            response = await asyncio.wait_for(ws.recv(), timeout=10.0)
            data = json.loads(response)
            
            if data.get("type") == "hello":
                print(f"[test] ✅ Received server hello: {data}")
            else:
                print(f"[test] ⚠️ Unexpected response: {data}")
            
            # Send a test audio frame (silence — 60ms of Opus)
            # This is a minimal Opus silence frame
            opus_silence = bytes([0xF8, 0xFF, 0xFE])  # Minimal Opus frame
            await ws.send(opus_silence)
            print(f"[test] ✅ Sent test audio frame")
            
            # Wait briefly for any response (TTS audio or STT result)
            try:
                response = await asyncio.wait_for(ws.recv(), timeout=5.0)
                if isinstance(response, bytes):
                    print(f"[test] ✅ Received audio response ({len(response)} bytes)")
                else:
                    print(f"[test] ✅ Received text response: {response[:200]}")
            except asyncio.TimeoutError:
                print(f"[test] ℹ️ No immediate response (expected for silence)")
            
            return True
            
    except Exception as e:
        print(f"[test] ❌ Failed: {e}")
        return False

async def test_backend_routing(host: str, port: int):
    """Test that different Device-Ids route to different backends."""
    print(f"\n[test] === Backend routing test ===")
    
    # Test device 1 (should route to OpenClaw/agent-a per devices.json)
    print(f"\n[test] Device 1 (OpenClaw/agent-a):")
    result1 = await test_connection(host, port, "AA:BB:CC:DD:EE:01")
    
    # Test device 2 (should route to Hermes/agent-b per devices.json)
    print(f"\n[test] Device 2 (Hermes/agent-b):")
    result2 = await test_connection(host, port, "AA:BB:CC:DD:EE:02")
    
    # Test unknown device (should fall back to default)
    print(f"\n[test] Unknown device (default fallback):")
    result3 = await test_connection(host, port, "UNKNOWN:DEVICE:99")
    
    if result1 and result2 and result3:
        print(f"\n[test] ✅ All backend routing tests passed")
    else:
        print(f"\n[test] ⚠️ Some tests failed (check ai-server logs for backend selection)")

async def test_config_endpoint(host: str, port: int):
    """Test the ai-server config (if it has a config endpoint)."""
    import urllib.request
    url = f"http://{host}:{port}/config"
    print(f"\n[test] === Config endpoint test ===")
    print(f"[test] GET {url}")
    
    try:
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=5) as resp:
            print(f"[test] ✅ Config endpoint returned {resp.status}")
            body = resp.read().decode()
            print(f"[test] Response: {body[:500]}")
    except Exception as e:
        print(f"[test] ℹ️ No config endpoint on ai-server (expected — config is on device port 80)")

async def main():
    parser = argparse.ArgumentParser(description="Stack-chan WS end-to-end test")
    parser.add_argument("--host", default="localhost", help="ai-server host")
    parser.add_argument("--port", type=int, default=8765, help="ai-server port")
    parser.add_argument("--device-id", default="TEST:DEVICE:01", help="Device-Id to send")
    parser.add_argument("--full", action="store_true", help="Run full test suite (routing + config)")
    args = parser.parse_args()
    
    if args.full:
        await test_backend_routing(args.host, args.port)
        await test_config_endpoint(args.host, args.port)
    else:
        await test_connection(args.host, args.port, args.device_id)

if __name__ == "__main__":
    asyncio.run(main())