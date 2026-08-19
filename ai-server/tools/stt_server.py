#!/usr/bin/env python3
"""STT server — OpenAI-compatible /v1/audio/transcriptions endpoint.
   Accepts multipart/form-data with audio file, returns JSON {"text": "..."}.
   Uses faster-whisper for fast CPU transcription."""
import json, sys, os, tempfile, re
from http.server import HTTPServer, BaseHTTPRequestHandler
from faster_whisper import WhisperModel

MODEL = WhisperModel("base", device="cpu", compute_type="int8")
LANGUAGE = os.environ.get("STT_LANGUAGE", "en")

def parse_multipart(body, boundary):
    """Extract file content from multipart/form-data."""
    boundary_bytes = boundary.encode()
    parts = body.split(b"--" + boundary_bytes)
    for part in parts:
        if b"filename=" in part:
            header_end = part.find(b"\r\n\r\n")
            if header_end > 0:
                file_data = part[header_end+4:]
                # Strip trailing boundary
                file_data = file_data.rstrip(b"\r\n-")
                return file_data
    return None

class SttHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        path = self.path
        if "/audio/transcriptions" not in path and path != "/":
            self.send_error(404, "Not found")
            return
        
        content_type = self.headers.get("Content-Type", "")
        content_length = int(self.headers["Content-Length"])
        body = self.rfile.read(content_length)
        
        audio_data = None
        if "multipart/form-data" in content_type:
            boundary = content_type.split("boundary=")[1]
            audio_data = parse_multipart(body, boundary)
        elif content_type.startswith("audio/"):
            audio_data = body
        else:
            # Try raw audio
            audio_data = body
        
        if not audio_data or len(audio_data) < 44:
            self.send_error(400, "No audio data found")
            return
        
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            f.write(audio_data)
            tmp_path = f.name
        
        try:
            segments, info = MODEL.transcribe(tmp_path, language=LANGUAGE if LANGUAGE != "auto" else None)
            text = " ".join([s.text.strip() for s in segments]).strip()
            print(f"[STT] transcribed ({len(audio_data)} bytes): {text!r}", file=sys.stderr)
            
            resp = json.dumps({"text": text}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(resp)))
            self.end_headers()
            self.wfile.write(resp)
        except Exception as e:
            print(f"[STT] ERROR: {e}", file=sys.stderr)
            self.send_error(500, str(e))
        finally:
            os.unlink(tmp_path)
    
    def log_message(self, fmt, *args):
        pass

if __name__ == "__main__":
    port = int(os.environ.get("STT_PORT", "52626"))
    print(f"[STT] faster-whisper server on port {port} (lang={LANGUAGE})", file=sys.stderr)
    HTTPServer(("127.0.0.1", port), SttHandler).serve_forever()