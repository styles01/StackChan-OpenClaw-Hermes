// stackchan_ex_config.h — Extended config for OpenClaw/Hermes backend binding
// Ported from plaipin's StackchanExConfig.h to ESP-IDF (uses NVS Settings, not Arduino SD/YAML)
#pragma once

#include <string>
#include "settings.h"

// Backend selector
#define BACKEND_OPENCLAW  0
#define BACKEND_HERMES    1

typedef struct {
    std::string host;
    int port;
    std::string agent_id;       // e.g. "your-agent", "hermes"
    std::string default_model;
} openclaw_s;

typedef struct {
    std::string host;
    int port;
    std::string agent_id;
    std::string default_model;
} hermes_s;

typedef struct {
    openclaw_s openclaw;
    hermes_s hermes;
    int backend;                 // 0=openclaw, 1=hermes
    std::string websocket_url;   // ws://host:8765/ws (ai-server endpoint)
    bool start_ai_on_boot;       // auto-launch AI Agent on boot (skip launcher)
} ex_config_s;

class StackchanExConfig {
public:
    static ex_config_s Load();
    static void Save(const ex_config_s& config);
    static void Print();

private:
    static constexpr const char* TAG = "StackchanExConfig";
    static constexpr const char* NVS_NAMESPACE = "stackchan_ex";
};