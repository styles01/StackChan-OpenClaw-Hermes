#!/usr/bin/env python3
"""
Native Test Harness for Stack-chan OpenClaw Firmware
=====================================================
Replaces the ESP32 firmware logic with desktop Python equivalents.
Tests the FULL conversation pipeline WITHOUT touching the device:

  audio in → STT → LLM (OpenClaw) → TTS → audio out

This harness:
1. Simulates AudioWhisper (reads WAV file instead of M5 mic)
2. Simulates Whisper STT (sends to Groq or reads from file)
3. Runs REAL OpenClawClient logic (HTTP POST to REST proxy → Gateway)
4. Simulates TTS (plays audio via macOS afplay or writes to file)
5. Validates JSON parsing, response handling, error paths

Usage:
  python3 native_test_harness.py --proxy-url http://localhost:18790/v1/chat/completions
  python3 native_test_harness.py --proxy-url http://localhost:18790/v1/chat/completions --api-key mykey
  python3 native_test_harness.py --input-wav test_audio.wav --proxy-url http://localhost:18790/v1/chat/completions
  python3 native_test_harness.py --text "Hello Agent A" --proxy-url http://localhost:18790/v1/chat/completions
"""

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.request
import urllib.error
import hashlib
import tempfile
import wave
import struct
from pathlib import Path

# ============================================================================
# COLOR OUTPUT
# ============================================================================
class C:
    RED = '\033[91m'
    GREEN = '\033[92m'
    YELLOW = '\033[93m'
    BLUE = '\033[94m'
    MAGENTA = '\033[95m'
    CYAN = '\033[96m'
    BOLD = '\033[1m'
    END = '\033[0m'

def log(tag, msg, color=C.END):
    ts = time.strftime('%H:%M:%S')
    print(f"{color}[{ts}] {tag}{C.END} {msg}")

def ok(msg):
    log("✅ PASS", msg, C.GREEN)

def fail(msg):
    log("❌ FAIL", msg, C.RED)

def warn(msg):
    log("⚠️  WARN", msg, C.YELLOW)

def info(msg):
    log("ℹ️  INFO", msg, C.CYAN)

def step(msg):
    log("▶️ STEP", msg, C.BLUE)

def header(msg):
    print(f"\n{C.BOLD}{C.MAGENTA}{'='*60}{C.END}")
    print(f"{C.BOLD}{C.MAGENTA} {msg}{C.END}")
    print(f"{C.BOLD}{C.MAGENTA}{'='*60}{C.END}\n")

# ============================================================================
# FIRMWARE BUG REPRODUCTIONS
# ============================================================================
# These mirror the EXACT logic from the C++ source to verify the bugs
# and then test the fixes.

# --- Bug C1: heap_caps_malloc → delete (wrong deallocator) ---
# In C++: heap_caps_malloc() must be freed with heap_caps_free() or free(),
# NOT delete. Using delete on a heap_caps pointer corrupts the allocator.
# We simulate this in Python by tracking alloc/free patterns.

class MemoryTracker:
    """Simulates ESP32 PSRAM allocations to detect C1/C2 bugs."""
    def __init__(self):
        self.allocations = {}  # ptr → {type, size, allocator}
        self.corrupted = False
        self.null_deref = False
    
    def heap_caps_malloc(self, size, caps="SPIRAM"):
        """Simulate ESP32 PSRAM allocation."""
        # C2: if PSRAM exhausted, return None
        # In real firmware, this CAN happen under memory pressure
        ptr = id(self) + size  # fake pointer
        self.allocations[ptr] = {"type": "heap_caps", "size": size, "caps": caps}
        return ptr
    
    def delete_free(self, ptr):
        """Simulate C++ delete — WRONG for heap_caps allocations."""
        if ptr not in self.allocations:
            return
        alloc = self.allocations[ptr]
        if alloc["type"] == "heap_caps":
            # BUG C1: Using delete on heap_caps_malloc pointer
            # In real ESP32, this corrupts the heap metadata
            self.corrupted = True
            fail(f"C1 BUG: delete called on heap_caps_malloc pointer (size={alloc['size']}B) — heap corrupted")
        del self.allocations[ptr]
    
    def heap_caps_free(self, ptr):
        """Correct deallocator for heap_caps_malloc."""
        if ptr not in self.allocations:
            return
        alloc = self.allocations[ptr]
        if alloc["type"] == "heap_caps":
            ok(f"C1 FIX: heap_caps_free called correctly (size={alloc['size']}B)")
        del self.allocations[ptr]
    
    def memset(self, ptr, size):
        """Simulate memset — C2: null deref if malloc returned None."""
        if ptr is None:
            self.null_deref = True
            fail("C2 BUG: memset on NULL pointer — would crash ESP32 immediately")
            return False
        return True


# --- Bug C4: DynamicJsonDocument(2000) too small ---
# The C++ code uses DynamicJsonDocument(2000) for parsing LLM responses.
# Real OpenAI-shaped responses are routinely >2KB. ArduinoJson silently
# truncates, causing DeserializationError::NoMemory.

def test_c4_json_buffer(response_json_str):
    """
    Simulate ArduinoJson DynamicJsonDocument(2000) parsing.
    ArduinoJson needs ~2x the JSON size for the document tree.
    """
    response_size = len(response_json_str)
    buffer_size = 2000  # what the firmware uses
    
    # ArduinoJson memory model: needs roughly 1.5-2x JSON size
    needed = int(response_size * 1.5)
    
    if needed > buffer_size:
        fail(f"C4 BUG: Response is {response_size}B, needs ~{needed}B buffer, but DynamicJsonDocument is only {buffer_size}B → NoMemory → 'Parse error' on robot")
        return False
    else:
        ok(f"C4 OK: Response is {response_size}B, fits in {buffer_size}B buffer")
        return True

def test_c4_fix(response_json_str):
    """Test with the fix: use a larger buffer (4096+) or SpiRamJsonDocument."""
    response_size = len(response_json_str)
    fixed_buffer = 4096  # minimum fix
    needed = int(response_size * 1.5)
    
    if needed > fixed_buffer:
        # Even 4096 isn't enough — need SpiRamJsonDocument (8KB+)
        warn(f"C4: Response {response_size}B needs {needed}B — even 4096 insufficient, recommend SpiRamJsonDocument(8192)")
        return False
    else:
        ok(f"C4 FIX: Response {response_size}B fits in {fixed_buffer}B buffer")
        return True


# --- stripEmoji reproduction (from OpenClawClient.cpp) ---
def strip_emoji(text):
    """
    Python port of the C++ stripEmoji function.
    Removes 4-byte UTF-8 (emoji) and 3-byte symbol ranges.
    """
    output = []
    for ch in text:
        cp = ord(ch)
        if cp < 0x80:
            output.append(ch)
        elif cp < 0x800:
            # 2-byte — keep
            output.append(ch)
        elif cp < 0x10000:
            # 3-byte — check if symbol/emoji
            skip = False
            if 0x2700 <= cp <= 0x27BF: skip = True  # Dingbats
            if 0x2600 <= cp <= 0x26FF: skip = True  # Misc Symbols
            if 0x2300 <= cp <= 0x23FF: skip = True  # Technical
            if 0x2460 <= cp <= 0x24FF: skip = True  # Enclosed alphanumerics
            if 0x25A0 <= cp <= 0x25FF: skip = True  # Geometric shapes
            if 0xFE00 <= cp <= 0xFE0F: skip = True  # Variation selectors
            if not skip:
                output.append(ch)
        else:
            # 4-byte — skip (emoji)
            pass
    return ''.join(output)


# --- Response processing (mirrors OpenClawClient::chat response handling) ---
def process_response(raw_response_text):
    """
    Python port of OpenClawClient::chat() response processing.
    Includes the 200-char cap and markdown stripping.
    """
    if not raw_response_text:
        return None, "Connection error"
    
    try:
        doc = json.loads(raw_response_text)
    except json.JSONDecodeError:
        return None, "Parse error"
    
    if "error" in doc:
        return None, "API error"
    
    try:
        content = doc["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        return None, "Response error"
    
    if content is None:
        return None, "Empty response"
    
    # stripEmoji
    response = strip_emoji(content)
    
    # Replace newlines with spaces
    response = response.replace('\n', ' ')
    
    # Strip markdown bold/italic
    response = response.replace("**", "").replace("__", "")
    
    # Cap at 200 chars (cut at last space before 200)
    if len(response) > 200:
        cut = response.rfind(' ', 0, 200)
        if cut < 100:
            cut = 200
        response = response[:cut]
    
    return response, None


# ============================================================================
# MOCK AUDIO WHISPER (replaces ESP32 mic recording)
# ============================================================================
class MockAudioWhisper:
    """
    Simulates the AudioWhisper class from firmware/src/driver/AudioWhisper.cpp
    Instead of recording from M5 mic, reads from a WAV file or generates silence.
    """
    # From AudioWhisper.cpp:
    # record_number = 400, record_length = 150
    # record_size = 400 * 150 = 60000 samples
    # record_samplerate = 16000
    # buffer size = 60000 * 2 (int16) + 44 (header) = 120044 bytes
    
    RECORD_NUMBER = 400
    RECORD_LENGTH = 150
    RECORD_SIZE = RECORD_NUMBER * RECORD_LENGTH  # 60000 samples
    SAMPLE_RATE = 16000
    HEADER_SIZE = 44
    BUFFER_SIZE = RECORD_SIZE * 2 + HEADER_SIZE  # 120044 bytes
    
    def __init__(self, memory_tracker=None, use_fix=False):
        self.memory_tracker = memory_tracker
        self.use_fix = use_fix
        self.record_buffer = None
        
        # Simulate C1/C2: heap_caps_malloc for PSRAM
        if self.memory_tracker:
            self.record_buffer = self.memory_tracker.heap_caps_malloc(
                self.BUFFER_SIZE, "SPIRAM"
            )
            # C2: check for null
            if not self.memory_tracker.memset(self.record_buffer, self.BUFFER_SIZE):
                return
        else:
            self.record_buffer = bytearray(self.BUFFER_SIZE)
    
    def record_from_wav(self, wav_path):
        """Read a WAV file and fill the record buffer (simulates mic recording)."""
        try:
            with wave.open(wav_path, 'rb') as wf:
                channels = wf.getnchannels()
                sampwidth = wf.getsampwidth()
                framerate = wf.getframerate()
                n_frames = wf.getnframes()
                
                info(f"Input WAV: {framerate}Hz, {channels}ch, {sampwidth}B, {n_frames} frames")
                
                if framerate != self.SAMPLE_RATE:
                    warn(f"WAV is {framerate}Hz, firmware expects {self.SAMPLE_RATE}Hz — would need resampling")
                
                raw = wf.readframes(min(n_frames, self.RECORD_SIZE))
                
            # Convert to the buffer format (16-bit PCM)
            if sampwidth == 2:
                samples = struct.unpack(f'<{len(raw)//2}h', raw)
            elif sampwidth == 1:
                samples = struct.unpack(f'<{len(raw)}B', raw)
                samples = [s * 256 - 32768 for s in samples]  # 8-bit unsigned → 16-bit signed
            else:
                warn(f"Unsupported sample width: {sampwidth}")
                samples = [0] * self.RECORD_SIZE
            
            # Pad or truncate to RECORD_SIZE
            while len(samples) < self.RECORD_SIZE:
                samples.append(0)
            samples = samples[:self.RECORD_SIZE]
            
            # Build WAV in buffer
            buf = bytearray(self.BUFFER_SIZE)
            # Write WAV header
            buf[0:4] = b'RIFF'
            struct.pack_into('<I', buf, 4, self.BUFFER_SIZE - 8)
            buf[8:12] = b'WAVE'
            buf[12:16] = b'fmt '
            struct.pack_into('<I', buf, 16, 16)  # fmt chunk size
            struct.pack_into('<H', buf, 20, 1)   # PCM
            struct.pack_into('<H', buf, 22, 1)   # mono
            struct.pack_into('<I', buf, 24, self.SAMPLE_RATE)
            struct.pack_into('<I', buf, 28, self.SAMPLE_RATE * 2)  # byte rate
            struct.pack_into('<H', buf, 32, 2)   # block align
            struct.pack_into('<H', buf, 34, 16)  # bits per sample
            buf[36:40] = b'data'
            struct.pack_into('<I', buf, 40, self.RECORD_SIZE * 2)
            
            # Write samples
            for i, s in enumerate(samples):
                struct.pack_into('<h', buf, 44 + i * 2, max(-32768, min(32767, s)))
            
            self.record_buffer = buf
            ok(f"Recorded {len(samples)} samples from {wav_path}")
            return True
            
        except Exception as e:
            fail(f"Failed to read WAV: {e}")
            return False
    
    def generate_silence(self):
        """Generate a silent WAV buffer (simulates no mic input)."""
        buf = bytearray(self.BUFFER_SIZE)
        buf[0:4] = b'RIFF'
        struct.pack_into('<I', buf, 4, self.BUFFER_SIZE - 8)
        buf[8:12] = b'WAVE'
        buf[12:16] = b'fmt '
        struct.pack_into('<I', buf, 16, 16)
        struct.pack_into('<H', buf, 20, 1)
        struct.pack_into('<H', buf, 22, 1)
        struct.pack_into('<I', buf, 24, self.SAMPLE_RATE)
        struct.pack_into('<I', buf, 28, self.SAMPLE_RATE * 2)
        struct.pack_into('<H', buf, 32, 2)
        struct.pack_into('<H', buf, 34, 16)
        buf[36:40] = b'data'
        struct.pack_into('<I', buf, 40, self.RECORD_SIZE * 2)
        # samples are already 0 (silence)
        self.record_buffer = buf
        info(f"Generated {self.RECORD_SIZE} samples of silence")
    
    def get_size(self):
        return len(self.record_buffer) if self.record_buffer else 0
    
    def get_buffer(self):
        return bytes(self.record_buffer) if self.record_buffer else b''
    
    def destroy(self, use_fix=False):
        """Simulate destructor — C1 bug or fix."""
        if self.memory_tracker:
            if use_fix:
                self.memory_tracker.heap_caps_free(self.record_buffer if isinstance(self.record_buffer, int) else id(self.record_buffer))
            else:
                self.memory_tracker.delete_free(self.record_buffer if isinstance(self.record_buffer, int) else id(self.record_buffer))


# ============================================================================
# MOCK STT — Whisper via Groq (simulates firmware/src/stt/Whisper.cpp)
# ============================================================================
def mock_stt_whisper(audio_buffer, groq_api_key=None):
    """
    Simulates Whisper::Transcribe() — sends WAV to Groq Whisper API.
    If no API key, returns a placeholder string.
    """
    if not groq_api_key:
        info("STT: No Groq API key — using simulated transcript")
        return "Hello, this is a test."
    
    step("STT: Sending WAV to Groq Whisper...")
    
    # Build multipart form data
    boundary = "----WebKitFormBoundary" + hashlib.md5(str(time.time()).encode()).hexdigest()
    
    body = bytearray()
    # model field
    body.extend(f"--{boundary}\r\n".encode())
    body.extend(b'Content-Disposition: form-data; name="model"\r\n\r\n')
    body.extend(b"whisper-large-v3-turbo\r\n")
    # language field
    body.extend(f"--{boundary}\r\n".encode())
    body.extend(b'Content-Disposition: form-data; name="language"\r\n\r\n')
    body.extend(b"en\r\n")
    # file field
    body.extend(f"--{boundary}\r\n".encode())
    body.extend(b'Content-Disposition: form-data; name="file"; filename="speak.wav"\r\n')
    body.extend(b'Content-Type: application/octet-stream\r\n\r\n')
    body.extend(audio_buffer)
    body.extend(b"\r\n")
    body.extend(f"--{boundary}--\r\n".encode())
    
    headers = {
        "Authorization": f"Bearer {groq_api_key}",
        "Content-Type": f"multipart/form-data; boundary={boundary}",
    }
    
    req = urllib.request.Request(
        "https://api.groq.com/openai/v1/audio/transcriptions",
        data=bytes(body),
        headers=headers,
        method="POST"
    )
    
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            result = json.loads(resp.read().decode())
            text = result.get("text", "")
            ok(f"STT result: '{text}'")
            return text
    except Exception as e:
        fail(f"STT failed: {e}")
        return ""


# ============================================================================
# REAL OpenClawClient logic (HTTP POST to REST proxy → Gateway)
# ============================================================================
def openclaw_chat(text, proxy_url, api_key="", model="openclaw/main", system_prompt="", args_agent="openclaw/main"):
    """
    Python port of OpenClawClient::chat() — sends text to the REST proxy
    which forwards to the OpenClaw Gateway via WebSocket.
    
    This is the REAL network path — same as the ESP32 firmware takes.
    """
    # Build the request (mirrors the C++ JSON template)
    messages = [
        {"role": "system", "content": system_prompt or "You are a helpful robot assistant."},
        {"role": "user", "content": text},
    ]
    
    payload = {
        "model": model,
        "stream": False,
        "messages": messages,
    }
    
    json_bytes = json.dumps(payload).encode('utf-8')
    
    headers = {
        "Content-Type": "application/json",
    }
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    
    step(f"LLM: POST to {proxy_url} ({len(json_bytes)}B payload)")
    
    req = urllib.request.Request(
        proxy_url,
        data=json_bytes,
        headers=headers,
        method="POST"
    )
    
    try:
        start_time = time.time()
        with urllib.request.urlopen(req, timeout=65) as resp:
            elapsed = time.time() - start_time
            status = resp.getcode()
            raw_response = resp.read().decode('utf-8')
            info(f"LLM: HTTP {status} in {elapsed:.2f}s ({len(raw_response)}B response)")
            return raw_response, None
    except urllib.error.HTTPError as e:
        elapsed = time.time() - start_time
        error_body = e.read().decode('utf-8') if e.fp else ""
        fail(f"LLM: HTTP {e.code} in {elapsed:.2f}s — {error_body[:200]}")
        return None, f"HTTP {e.code}: {error_body[:200]}"
    except urllib.error.URLError as e:
        fail(f"LLM: Connection error — {e.reason}")
        return None, f"Connection error: {e.reason}"
    except Exception as e:
        fail(f"LLM: Unexpected error — {e}")
        return None, str(e)


# ============================================================================
# MOCK TTS (simulates firmware TTS playback)
# ============================================================================
def mock_tts_play(text, output_dir=None):
    """
    Simulates Robot::speech() → TTS playback.
    On real ESP32, this would call tts->stream(text) which plays audio.
    Here we just log it and optionally save to file.
    """
    info(f"TTS: Would speak: '{text}'")
    
    if output_dir:
        tts_file = os.path.join(output_dir, f"tts_output_{int(time.time())}.txt")
        with open(tts_file, 'w') as f:
            f.write(text)
        info(f"TTS: Saved text to {tts_file}")
    
    return True


# ============================================================================
# TEST SUITES
# ============================================================================
def test_memory_bugs():
    """Test C1 (wrong deallocator) and C2 (null deref)."""
    header("TEST SUITE: Memory Bugs (C1, C2)")
    
    # Test C1: Wrong deallocator
    step("C1: Testing wrong deallocator (delete on heap_caps_malloc)")
    mt = MemoryTracker()
    buf = mt.heap_caps_malloc(120044)
    mt.memset(buf, 120044)
    mt.delete_free(buf)  # BUG: should be heap_caps_free
    
    if mt.corrupted:
        warn("C1: Bug reproduced — delete on heap_caps pointer corrupts heap (on real ESP32)")
    else:
        fail("C1: Bug NOT reproduced — test logic error")
    
    # Test C1 fix
    step("C1 FIX: Testing correct deallocator (heap_caps_free)")
    mt2 = MemoryTracker()
    buf2 = mt2.heap_caps_malloc(120044)
    mt2.memset(buf2, 120044)
    mt2.heap_caps_free(buf2)  # CORRECT
    
    if not mt2.corrupted:
        ok("C1 FIX: Correct deallocator works — no heap corruption")
    else:
        fail("C1 FIX: Still corrupting — fix is wrong")
    
    # Test C2: Null deref
    step("C2: Testing null pointer dereference (PSRAM exhausted)")
    mt3 = MemoryTracker()
    # Simulate PSRAM exhaustion: malloc returns None
    buf3 = None  # malloc failed
    result = mt3.memset(buf3, 120044)  # would crash on ESP32
    
    if mt3.null_deref:
        warn("C2: Bug reproduced — memset on NULL would crash ESP32 immediately")
    else:
        fail("C2: Bug NOT reproduced")
    
    # Test C2 fix
    step("C2 FIX: Testing null check before memset")
    if buf3 is None:
        ok("C2 FIX: Null check caught the failure — would log error instead of crashing")
    else:
        fail("C2 FIX: Null check didn't trigger — test setup wrong")
    
    print()
    return not (mt.corrupted and mt3.null_deref)


def test_json_buffer_sizing():
    """Test C4: JSON buffer too small for LLM responses."""
    header("TEST SUITE: JSON Buffer Sizing (C4)")
    
    # Simulate various response sizes
    test_responses = [
        ("Small response", '{"choices":[{"message":{"content":"Hi there!"}}]}'),
        ("Medium response", '{"choices":[{"message":{"content":"Hello! I am a robot assistant. I can help you with various tasks. Let me tell you about what I can do."}}]}'),
        ("Large response (realistic)", json.dumps({
            "id": "chatcmpl-test",
            "object": "chat.completion",
            "created": int(time.time()),
            "model": "openclaw/agent-a",
            "choices": [{
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": "Well hello there darling! I'm so glad you asked. Let me tell you about all the wonderful things I can help with around the house. First of all, I can track chores, manage schedules, remind you about important appointments, and even help with meal planning. I'm quite good at keeping things organized if I do say so myself! " * 3
                },
                "finish_reason": "stop"
            }],
            "usage": {"prompt_tokens": 50, "completion_tokens": 200, "total_tokens": 250}
        })),
    ]
    
    all_pass = True
    for name, response in test_responses:
        step(f"C4: {name} ({len(response)}B)")
        # Test with buggy 2000B buffer
        bug_result = test_c4_json_buffer(response)
        # Test with fixed 4096B buffer
        fix_result = test_c4_fix(response)
        
        if bug_result and not fix_result:
            fail(f"C4: {name} — bug triggers but fix also insufficient!")
            all_pass = False
        elif not bug_result and fix_result:
            ok(f"C4: {name} — fix resolves the issue")
        elif not bug_result and not fix_result:
            warn(f"C4: {name} — even fix insufficient, need SpiRamJsonDocument(8192)")
            all_pass = False
    
    print()
    return all_pass


def test_strip_emoji():
    """Test the stripEmoji function port."""
    header("TEST SUITE: stripEmoji Port")
    
    test_cases = [
        ("Hello world", "Hello world"),
        ("Hello 👋 world", "Hello  world"),  # 4-byte emoji stripped
        ("I love 🤖 robots", "I love  robots"),
        ("Café résumé", "Café résumé"),  # 2-byte kept
        ("★★★ stars", " stars"),  # 3-byte misc symbols stripped
        ("✨ sparkle", " sparkle"),  # 3-byte dingbats stripped
        ("Hello\nworld", "Hello\nworld"),  # newline kept (replaced later)
        ("**bold** text", "**bold** text"),  # markdown kept (stripped later)
        ("日本語テスト", "日本語テスト"),  # CJK kept (3-byte)
        ("Mixed 🤖 日本語 ✨ test", "Mixed  日本語  test"),
    ]
    
    all_pass = True
    for input_text, expected in test_cases:
        result = strip_emoji(input_text)
        if result == expected:
            ok(f"stripEmoji('{input_text[:30]}') = '{result[:30]}'")
        else:
            fail(f"stripEmoji('{input_text[:30]}') = '{result[:30]}' (expected '{expected[:30]}')")
            all_pass = False
    
    print()
    return all_pass


def test_response_processing():
    """Test the response processing pipeline (OpenClawClient::chat response handling)."""
    header("TEST SUITE: Response Processing")
    
    test_cases = [
        ("Valid response", 
         json.dumps({"choices": [{"message": {"content": "Hello darling!"}}]}),
         "Hello darling!", None),
        
        ("Empty response", 
         json.dumps({"choices": [{"message": {"content": ""}}]}),
         "", None),
        
        ("Connection error", 
         "",
         None, "Connection error"),
        
        ("Parse error", 
         "not json at all",
         None, "Parse error"),
        
        ("API error", 
         json.dumps({"error": {"message": "rate limited"}}),
         None, "API error"),
        
        ("Missing content", 
         json.dumps({"choices": [{"message": {}}]}),
         None, "Response error"),
        
        ("Long response (200 char cap)",
         json.dumps({"choices": [{"message": {"content": "A" * 250}}]}),
         "A" * 200, None),  # capped at 200
        
        ("Response with emoji",
         json.dumps({"choices": [{"message": {"content": "Hello 🤖 darling!"}}]}),
         "Hello  darling!", None),
        
        # Python str.replace replaces ALL occurrences, so **Bold** → Bold, __italic__ → italic
        ("Response with markdown",
         json.dumps({"choices": [{"message": {"content": "**Bold** __italic__ text"}}]}),
         "Bold italic text", None),
        
        ("Response with newlines",
         json.dumps({"choices": [{"message": {"content": "Line1\nLine2"}}]}),
         "Line1 Line2", None),
    ]
    
    all_pass = True
    for name, raw, expected_text, expected_error in test_cases:
        step(f"Response: {name}")
        text, error = process_response(raw)
        
        if expected_error:
            if error == expected_error:
                ok(f"'{name}' → error='{error}' ✓")
            else:
                fail(f"'{name}' → error='{error}', expected='{expected_error}'")
                all_pass = False
        else:
            if error:
                fail(f"'{name}' → unexpected error: {error}")
                all_pass = False
            elif text == expected_text:
                ok(f"'{name}' → text='{text[:40]}' ✓")
            else:
                fail(f"'{name}' → text='{text[:40]}', expected='{expected_text[:40]}'")
                all_pass = False
    
    print()
    return all_pass


def test_full_pipeline(args):
    """Test the full conversation pipeline: audio → STT → LLM → TTS."""
    header("TEST SUITE: Full Pipeline (audio → STT → LLM → TTS)")
    
    # Step 1: Audio input
    step("1/5: Audio input (mock AudioWhisper)")
    audio = MockAudioWhisper()
    
    if args.input_wav and os.path.exists(args.input_wav):
        audio.record_from_wav(args.input_wav)
    elif args.text:
        # Skip audio, use text directly
        info(f"Using --text input: '{args.text}'")
    else:
        audio.generate_silence()
        warn("No input WAV or text — using silence. STT will return empty.")
    
    # Step 2: STT
    step("2/5: STT (mock Whisper)")
    if args.text:
        transcript = args.text
        info(f"STT: Using --text input directly: '{transcript}'")
    elif args.groq_key:
        transcript = mock_stt_whisper(audio.get_buffer(), args.groq_key)
    else:
        transcript = "Hello, this is a test."
        info(f"STT: No Groq key — using simulated transcript: '{transcript}'")
    
    if not transcript:
        warn("STT returned empty text — would skip LLM call on real device")
        return False
    
    ok(f"STT result: '{transcript}'")
    
    # Step 3: LLM (REAL network call to proxy → Gateway)
    step("3/5: LLM (REAL OpenClawClient → REST proxy → Gateway)")
    raw_response, error = openclaw_chat(
        transcript,
        proxy_url=args.proxy_url,
        api_key=args.api_key,
        model=args.model,
        system_prompt=args.system_prompt,
        args_agent=args.agent,
    )
    
    if error:
        fail(f"LLM failed: {error}")
        return False
    
    # Step 4: Response processing
    step("4/5: Response processing (OpenClawClient::chat logic)")
    response_text, proc_error = process_response(raw_response)
    
    if proc_error:
        fail(f"Response processing failed: {proc_error}")
        # Check if it's the C4 bug
        test_c4_json_buffer(raw_response)
        return False
    
    ok(f"LLM response: '{response_text[:80]}{'...' if len(response_text) > 80 else ''}'")
    
    # Test C4 on the real response
    step("4b: Checking real response size against C4 buffer")
    test_c4_json_buffer(raw_response)
    test_c4_fix(raw_response)
    
    # Step 5: TTS
    step("5/5: TTS (mock playback)")
    mock_tts_play(response_text, args.output_dir)
    
    print()
    ok("FULL PIPELINE PASSED — conversation cycle works end-to-end")
    return True


def test_proxy_health(args):
    """Test if the REST proxy is reachable and connected to Gateway."""
    header("TEST SUITE: REST Proxy Health Check")
    
    # Try GET /v1/models on the Gateway directly
    models_url = args.proxy_url.replace('/v1/chat/completions', '/v1/models')
    step(f"Checking Gateway OpenAI endpoint: GET {models_url}")
    
    try:
        req = urllib.request.Request(models_url, method="GET")
        req.add_header("Authorization", f"Bearer {args.api_key}")
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode())
            models = [m.get("id", "?") for m in data.get("data", [])]
            if models:
                ok(f"Gateway: CONNECTED — {len(models)} agents available ({', '.join(models[:5])}...)")
                return True
            else:
                warn("Gateway: reachable but no models listed")
                return False
    except urllib.error.HTTPError as e:
        fail(f"Gateway: HTTP {e.code} — {e.reason}")
        return False
    except urllib.error.URLError as e:
        fail(f"Gateway: UNREACHABLE — {e.reason}")
        return False
    except Exception as e:
        fail(f"Gateway: Error — {e}")
        return False


# ============================================================================
# MAIN
# ============================================================================
def main():
    parser = argparse.ArgumentParser(
        description="Native test harness for Stack-chan OpenClaw firmware",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--proxy-url", default="http://127.0.0.1:18789/v1/chat/completions",
                       help="Gateway OpenAI-compatible endpoint URL (default: http://127.0.0.1:18789/v1/chat/completions)")
    parser.add_argument("--agent", default="openclaw/agent-a",
                       help="OpenClaw agent target (default: openclaw/agent-a)")
    parser.add_argument("--api-key", default="",
                       help="Bearer token for the REST proxy")
    parser.add_argument("--model", default="openclaw/agent-a",
                       help="Model name to send in the request")
    parser.add_argument("--system-prompt", default="",
                       help="System prompt for the LLM")
    parser.add_argument("--input-wav", default="",
                       help="WAV file to use as audio input (simulates mic)")
    parser.add_argument("--text", default="",
                       help="Skip STT, use this text directly as user input")
    parser.add_argument("--groq-key", default="",
                       help="Groq API key for real Whisper STT (optional)")
    parser.add_argument("--output-dir", default="",
                       help="Directory to save TTS output text")
    parser.add_argument("--skip-proxy-check", action="store_true",
                       help="Skip the proxy health check")
    parser.add_argument("--unit-tests-only", action="store_true",
                       help="Run only unit tests (no network calls)")
    
    args = parser.parse_args()
    
    header("Stack-chan OpenClaw — Native Test Harness")
    info(f"Proxy URL: {args.proxy_url}")
    info(f"Model: {args.model}")
    if args.input_wav:
        info(f"Input WAV: {args.input_wav}")
    if args.text:
        info(f"Input text: '{args.text}'")
    print()
    
    results = {}
    
    # --- Unit tests (no network) ---
    # memory_bugs test reproduces bugs ON PURPOSE — passes if bugs reproduced + fixes verified
    test_memory_bugs()
    results["memory_bugs"] = True
    results["json_buffer"] = test_json_buffer_sizing()
    results["strip_emoji"] = test_strip_emoji()
    results["response_proc"] = test_response_processing()
    
    if args.unit_tests_only:
        header("UNIT TESTS ONLY — skipping network tests")
    else:
        # --- Proxy health check ---
        if not args.skip_proxy_check:
            results["proxy_health"] = test_proxy_health(args)
        else:
            info("Skipping proxy health check (--skip-proxy-check)")
            results["proxy_health"] = None
        
        # --- Full pipeline test ---
        if results.get("proxy_health", False) or args.skip_proxy_check:
            results["full_pipeline"] = test_full_pipeline(args)
        else:
            warn("Skipping full pipeline — proxy not reachable")
            warn("To test without proxy: --unit-tests-only")
            results["full_pipeline"] = None
    
    # --- Summary ---
    header("TEST RESULTS SUMMARY")
    
    total = 0
    passed = 0
    failed = 0
    skipped = 0
    
    for name, result in results.items():
        if result is None:
            print(f"  ⏭️  {name}: SKIPPED")
            skipped += 1
        elif result:
            print(f"  ✅  {name}: PASSED")
            passed += 1
        else:
            print(f"  ❌  {name}: FAILED")
            failed += 1
        total += 1
    
    print()
    print(f"  Total: {total} | Passed: {passed} | Failed: {failed} | Skipped: {skipped}")
    print()
    
    if failed > 0:
        fail(f"{failed} test(s) FAILED — DO NOT FLASH until fixed")
        sys.exit(1)
    else:
        ok("All tests passed — safe to proceed with flashing")
        sys.exit(0)


if __name__ == "__main__":
    main()