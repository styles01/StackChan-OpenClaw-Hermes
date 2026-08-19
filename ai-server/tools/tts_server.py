#!/usr/bin/env python3
"""TTS server — accepts UTF-8 text as POST body, returns WAV audio.
   Uses edge-tts (Microsoft Edge TTS, free, no API keys).
   Compatible with ai-server's STACKCHAN_LOCAL_TTS_URL format."""
import sys, os, tempfile, asyncio, subprocess
from http.server import HTTPServer, BaseHTTPRequestHandler

# Voice mapping — ai-server sends Japanese text, use a JP voice
# Fall back to en-US if text looks English
DEFAULT_VOICE = os.environ.get("TTS_VOICE", "en-GB-LibbyNeural")
FALLBACK_VOICE = os.environ.get("TTS_FALLBACK_VOICE", "en-GB-LibbyNeural")

def is_mostly_ascii(text: str) -> bool:
    # Always use the configured voice — no language switching
    return True

async def synthesize(text: str, voice: str) -> bytes:
    """Use edge-tts to generate MP3, then ffmpeg to convert to WAV (24kHz mono)."""
    import edge_tts
    
    mp3_path = tempfile.mktemp(suffix=".mp3")
    wav_path = tempfile.mktemp(suffix=".wav")
    
    try:
        communicate = edge_tts.Communicate(text, voice)
        await communicate.save(mp3_path)
        
        # Convert MP3 to WAV (24kHz mono, 16-bit) via ffmpeg
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", mp3_path,
             "-ac", "1", "-ar", "24000", "-sample_fmt", "s16", wav_path],
            check=True, capture_output=True
        )
        
        with open(wav_path, "rb") as f:
            return f.read()
    finally:
        for p in [mp3_path, wav_path]:
            try: os.unlink(p)
            except: pass

class TtsHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        content_length = int(self.headers["Content-Length"])
        text = self.rfile.read(content_length).decode("utf-8").strip()
        
        if not text:
            self.send_error(400, "Empty text")
            return
        
        voice = FALLBACK_VOICE if is_mostly_ascii(text) else DEFAULT_VOICE
        print(f"[TTS] synthesizing: {text!r} (voice={voice})", file=sys.stderr)
        
        try:
            wav = asyncio.run(synthesize(text, voice))
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.end_headers()
            self.wfile.write(wav)
            print(f"[TTS] OK: {len(wav)} bytes", file=sys.stderr)
        except Exception as e:
            print(f"[TTS] ERROR: {e}", file=sys.stderr)
            self.send_error(500, str(e))
    
    def log_message(self, format, *args):
        pass

if __name__ == "__main__":
    port = int(os.environ.get("TTS_PORT", "18002"))
    print(f"[TTS] edge-tts server on port {port} (voice={DEFAULT_VOICE}, fallback={FALLBACK_VOICE})", file=sys.stderr)
    HTTPServer(("127.0.0.1", port), TtsHandler).serve_forever()