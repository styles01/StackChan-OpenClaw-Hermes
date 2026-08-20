#!/usr/bin/env python3
"""
Agent A MCP Server for Stack-chan via xiaozhi.me broker.

The xiaozhi.me broker connects Stack-chan (ESP32-S3 robot) to us.
We are the MCP SERVER — we expose Agent A's household tools to the robot.
The robot becomes a physical node of Agent A — it can ask about household
status, send messages, check the printer, update the fridge dashboard, etc.

Architecture:
    Stack-chan (ESP32-S3)
        ↕ WebSocket (xiaozhi-esp32 firmware)
    xiaozhi.me Cloud MCP Broker
        ↕ WSS (MCP protocol — broker is client, we are server)
    Agent A MCP Server (this script, on <your-host>)
        ↕ subprocess/MQTT/API calls
    Household systems (printer, fridge, Telegram, memory, calendar)

Usage:
    python3 server.py [--env .env]

Environment variables (or .env file):
    STACKCHAN_TOKEN  — JWT token from xiaozhi.me (required)
"""
import json
import asyncio
import websockets
import os
import subprocess
import datetime
import logging

# ─── Config ──────────────────────────────────────────────────────────────────

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
WSS_URL_TEMPLATE = "wss://api.xiaozhi.me/mcp/?token={token}"

def load_env(env_path=None):
    """Load .env file if present."""
    path = env_path or os.path.join(SCRIPT_DIR, ".env")
    if os.path.exists(path):
        with open(path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, _, val = line.partition("=")
                    os.environ.setdefault(key.strip(), val.strip())

load_env()
TOKEN = os.environ.get("STACKCHAN_TOKEN", "")
WSS_URL = WSS_URL_TEMPLATE.format(token=TOKEN)

# ─── Logging ─────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S"
)
log = logging.getLogger("agent-a-stackchan")

# ─── Paths ────────────────────────────────────────────────────────────────────

WORKSPACE = "<your-home>/openclaw-workspaces/agent-a"
TTS_SCRIPT = "<your-home>/.openclaw/workspace/tts-machine/run_tts.py"
BAMBU_ACCESS_CODE_FILE = "<your-home>/.config/bambu/a1mini-access-code.txt"
FRIDGE_DATA_DIR = os.path.expanduser("~/.hermes/workspace/eink-fridge/data")
MEMORY_FILE = os.path.join(WORKSPACE, "MEMORY.md")

CHAT_IDS = {
    "james": "<REDACTED_TELEGRAM_ID",
    "gabby": "<REDACTED_TELEGRAM_ID",
    "group": "<REDACTED_GROUP_ID",
}

# ─── Tools ────────────────────────────────────────────────────────────────────

ROSIE_TOOLS = [
    {
        "name": "agent-a_status",
        "description": "Get Agent A's household status summary — chores, printer, weather, and upcoming events.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "detail": {"type": "string", "enum": ["brief", "full"], "description": "Brief = one line, Full = detailed breakdown", "default": "brief"}
            }
        }
    },
    {
        "name": "agent-a_say",
        "description": "Have Agent A send a voice note or text message to James, Gabby, or the household group via Telegram.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "message": {"type": "string", "description": "The message to send"},
                "target": {"type": "string", "enum": ["james", "gabby", "group"], "description": "Who to send to", "default": "james"},
                "voice": {"type": "boolean", "description": "Send as voice note (TTS) or text", "default": False}
            },
            "required": ["message"]
        }
    },
    {
        "name": "agent-a_printer_status",
        "description": "Check the 3D printer (Bambu Lab A1 Mini) status — state, progress, temperatures, errors.",
        "inputSchema": {"type": "object", "properties": {}}
    },
    {
        "name": "agent-a_fridge_update",
        "description": "Update the fridge E-Ink dashboard with notes or todos.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "type": {"type": "string", "enum": ["note", "todo"], "description": "Note or todo item"},
                "action": {"type": "string", "enum": ["add", "remove", "list"], "description": "Add, remove, or list items", "default": "add"},
                "text": {"type": "string", "description": "The note/todo text (max 20 chars)"}
            },
            "required": ["type", "action"]
        }
    },
    {
        "name": "agent-a_memory",
        "description": "Search Agent A's memory for household information, preferences, or past events.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "What to search for"}
            },
            "required": ["query"]
        }
    },
    {
        "name": "agent-a_time",
        "description": "Get the current time and date in the household timezone (Eastern Time).",
        "inputSchema": {"type": "object", "properties": {}}
    },
    {
        "name": "agent-a_echo",
        "description": "Simple echo tool for testing connectivity. Returns what you send.",
        "inputSchema": {
            "type": "object",
            "properties": {"text": {"type": "string", "description": "Text to echo back"}},
            "required": ["text"]
        }
    },
]

# ─── Tool Handlers ────────────────────────────────────────────────────────────

async def handle_tool_call(name, args):
    """Execute a Agent A tool and return the result as a string."""
    log.info(f"Tool call: {name} args={json.dumps(args)[:200]}")

    if name == "agent-a_echo":
        return f"Agent A says: {args.get('text', '...')} 👋"

    if name == "agent-a_time":
        now = datetime.datetime.now()
        return f"Household time (ET): {now.strftime('%I:%M %p on %A, %B %d, %Y')}"

    if name == "agent-a_status":
        detail = args.get("detail", "brief")
        now = datetime.datetime.now()
        baby_days = (now - datetime.datetime(2026, 8, 1)).days
        if detail == "brief":
            return f"Agent A online. Household time: {now.strftime('%I:%M %p ET, %A')}. Baby is {baby_days} days old. All systems nominal, darling."
        else:
            return (
                f"Agent A Household Status Report\n"
                f"Time: {now.strftime('%I:%M %p ET, %A %B %d')}\n"
                f"Baby: {baby_days} days old\n"
                f"Postpartum tips: Running daily at 7 AM ET\n"
                f"3D Printer: Use agent-a_printer_status for details\n"
                f"Status: All systems nominal, darling."
            )

    if name == "agent-a_say":
        msg = args.get("message", "")
        target = args.get("target", "james")
        voice = args.get("voice", False)
        chat_id = CHAT_IDS.get(target, CHAT_IDS["james"])

        if voice:
            try:
                result = subprocess.run(
                    ["python3", TTS_SCRIPT, msg,
                     "--agent", "agent-a", "--send-telegram", "--chat-id", chat_id],
                    capture_output=True, text=True, timeout=30
                )
                if result.returncode == 0:
                    return f"Voice note sent to {target} ✅"
                else:
                    return f"Voice note failed: {result.stderr[:200]}"
            except Exception as e:
                return f"Voice note error: {e}"
        else:
            # Text message via openclaw
            try:
                result = subprocess.run(
                    ["openclaw", "message", "send",
                     "--account", "agent-a", "--channel", "telegram",
                     "--target", chat_id, "--message", msg],
                    capture_output=True, text=True, timeout=15
                )
                if result.returncode == 0:
                    return f"Text message sent to {target} ✅"
                else:
                    return f"Text message failed: {result.stderr[:200]}"
            except Exception as e:
                return f"Text message error: {e}"

    if name == "agent-a_printer_status":
        try:
            result = subprocess.run(
                ["python3", "-c", '''
import ssl, json, time
import paho.mqtt.client as mqtt
ACCESS_CODE = open("<your-home>/.config/bambu/a1mini-access-code.txt").read().strip()
SERIAL = "0300CA662400052"
got = []
def on_connect(c,u,f,rc,p=None):
    c.subscribe(f"device/{SERIAL}/report")
    c.publish(f"device/{SERIAL}/request", json.dumps({"pushing":{"sequence_id":"0","command":"pushall"}}))
def on_msg(c,u,m):
    d = json.loads(m.payload)
    if "print" in d and d["print"].get("command")=="push_status" and len(d["print"])>30:
        got.append(d["print"])
cli = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="agent-a_sc")
cli.username_pw_set("bblp", ACCESS_CODE)
cli.on_connect = on_connect
cli.on_message = on_msg
ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE
cli.tls_set_context(ctx)
cli.connect("<PRINTER_IP>", 8883, 30)
cli.loop_start()
time.sleep(8)
cli.loop_stop()
cli.disconnect()
if got:
    p = got[-1]
    print(f"State: {p.get('gcode_state','?')}")
    print(f"Progress: {p.get('mc_percent',0)}%")
    print(f"Layer: {p.get('layer_num',0)}/{p.get('total_layer_num',0)}")
    print(f"Nozzle: {p.get('nozzle_temper',0)}C")
    print(f"Bed: {p.get('bed_temper',0)}C")
    print(f"Remaining: {p.get('mc_remaining_time',0)} min")
    print(f"Error: {p.get('print_error',0)}")
else:
    print("Could not reach printer")
'''],
                capture_output=True, text=True, timeout=15
            )
            return result.stdout.strip() if result.returncode == 0 else f"Printer check failed: {result.stderr[:200]}"
        except Exception as e:
            return f"Printer error: {e}"

    if name == "agent-a_fridge_update":
        action = args.get("action", "add")
        item_type = args.get("type", "note")
        text = args.get("text", "")

        if action == "list":
            results = []
            for f in ["notes", "todos"]:
                path = os.path.join(FRIDGE_DATA_DIR, f"{f}.txt")
                if os.path.exists(path):
                    with open(path) as fh:
                        items = [l.strip() for l in fh if l.strip()]
                    results.append(f"{f}: {json.dumps(items)}")
            return "\n".join(results) if results else "No fridge data found"

        if action == "add" and text:
            path = os.path.join(FRIDGE_DATA_DIR, f"{item_type}s.txt")
            with open(path, "a") as fh:
                fh.write(text[:20] + "\n")
            return f"Added {item_type}: '{text[:20]}' to fridge dashboard"

        return f"Fridge {action} {item_type}: needs text for add/remove"

    if name == "agent-a_memory":
        query = args.get("query", "")
        try:
            result = subprocess.run(
                ["grep", "-ri", query, MEMORY_FILE],
                capture_output=True, text=True, timeout=5
            )
            lines = [l for l in result.stdout.strip().split("\n") if l.strip()]
            return "\n".join(lines[:5]) if lines else "No memory matches found"
        except Exception as e:
            return f"Memory search error: {e}"

    return f"Unknown tool: {name}"


# ─── MCP Server ──────────────────────────────────────────────────────────────

async def handle_message(ws, data):
    """Process incoming MCP messages from the broker."""
    method = data.get("method", "")
    msg_id = data.get("id")

    if method == "initialize":
        resp = {
            "jsonrpc": "2.0",
            "id": msg_id,
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": {
                    "tools": {"listChanged": False},
                    "sampling": {},
                    "roots": {"listChanged": False}
                },
                "serverInfo": {
                    "name": "agent-a-household-ops",
                    "version": "1.0.0",
                    "description": "Agent A — Household Operations Director. Manages chores, printer, fridge dashboard, reminders, and family logistics."
                }
            }
        }
        await ws.send(json.dumps(resp))
        log.info("initialize → sent server info (Agent A v1.0.0)")

    elif method == "notifications/initialized":
        log.info("Broker confirmed initialization — Agent A tools are live!")

    elif method == "tools/list":
        resp = {
            "jsonrpc": "2.0",
            "id": msg_id,
            "result": {"tools": ROSIE_TOOLS}
        }
        await ws.send(json.dumps(resp))
        tool_names = [t["name"] for t in ROSIE_TOOLS]
        log.info(f"tools/list → sent {len(ROSIE_TOOLS)} tools: {', '.join(tool_names)}")

    elif method == "tools/call":
        params = data.get("params", {})
        tool_name = params.get("name", "")
        tool_args = params.get("arguments", {})

        log.info(f"INCOMING TOOL CALL: {tool_name}")

        try:
            result_text = await handle_tool_call(tool_name, tool_args)
        except Exception as e:
            result_text = f"Error executing {tool_name}: {e}"

        resp = {
            "jsonrpc": "2.0",
            "id": msg_id,
            "result": {
                "content": [{"type": "text", "text": result_text}],
                "isError": False
            }
        }
        await ws.send(json.dumps(resp))
        log.info(f"Result: {result_text[:100]}")

    elif method == "ping":
        await ws.send(json.dumps({"jsonrpc": "2.0", "id": msg_id, "result": {}}))

    elif msg_id is not None:
        await ws.send(json.dumps({"jsonrpc": "2.0", "id": msg_id, "result": {}}))
        log.info(f"Generic response to {method}")


async def run():
    """Main loop — connect, handshake, serve tools, reconnect on drop."""
    if not TOKEN:
        log.error("No STACKCHAN_TOKEN set! Put it in .env or environment.")
        return

    log.info("🤖 Agent A MCP Server for Stack-chan")
    log.info(f"   Connecting to xiaozhi.me broker...")

    while True:
        try:
            async with websockets.connect(WSS_URL, ping_interval=30, ping_timeout=10) as ws:
                log.info("✅ Connected! Waiting for broker handshake...")

                while True:
                    try:
                        msg = await asyncio.wait_for(ws.recv(), timeout=180)
                        data = json.loads(msg)
                        await handle_message(ws, data)
                    except asyncio.TimeoutError:
                        log.debug("No messages for 3 min, sending keepalive...")
                        await ws.send(json.dumps({"jsonrpc": "2.0", "method": "ping"}))
                    except websockets.ConnectionClosed:
                        log.warning("🔌 Connection closed.")
                        break

        except Exception as e:
            log.error(f"Connection error: {e}")

        log.info("Reconnecting in 10 seconds...")
        await asyncio.sleep(10)


if __name__ == "__main__":
    asyncio.run(run())