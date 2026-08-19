// stackchan_ex_config.cc — Extended config for OpenClaw/Hermes backend binding
// Ported from plaipin's StackchanExConfig to ESP-IDF (NVS-based, no Arduino deps)
#include "stackchan_ex_config.h"
#include "esp_log.h"

ex_config_s StackchanExConfig::Load() {
    Settings settings(NVS_NAMESPACE, false); // read-only
    
    ex_config_s config = {};
    
    // Backend selector
    config.backend = settings.GetInt("backend", BACKEND_OPENCLAW);
    
    // WebSocket URL (ai-server endpoint)
    config.websocket_url = settings.GetString("websocket_url", "");
    config.start_ai_on_boot = settings.GetBool("start_ai_boot", false);
    
    // OpenClaw config
    config.openclaw.host = settings.GetString("oc_host", "");
    config.openclaw.port = settings.GetInt("oc_port", 18789);
    config.openclaw.agent_id = settings.GetString("oc_agent_id", "rosie");
    config.openclaw.default_model = settings.GetString("oc_def_model", "openclaw/rosie");
    
    // Hermes config
    config.hermes.host = settings.GetString("hm_host", "");
    config.hermes.port = settings.GetInt("hm_port", 8643);
    config.hermes.agent_id = settings.GetString("hm_agent_id", "hermes");
    config.hermes.default_model = settings.GetString("hm_def_model", "hermes/venus");
    
    return config;
}

void StackchanExConfig::Save(const ex_config_s& config) {
    Settings settings(NVS_NAMESPACE, true); // read-write
    
    settings.SetInt("backend", config.backend);
    settings.SetString("websocket_url", config.websocket_url);
    settings.SetBool("start_ai_boot", config.start_ai_on_boot);
    settings.SetString("oc_host", config.openclaw.host);
    settings.SetInt("oc_port", config.openclaw.port);
    settings.SetString("oc_agent_id", config.openclaw.agent_id);
    settings.SetString("oc_def_model", config.openclaw.default_model);
    settings.SetString("hm_host", config.hermes.host);
    settings.SetInt("hm_port", config.hermes.port);
    settings.SetString("hm_agent_id", config.hermes.agent_id);
    settings.SetString("hm_def_model", config.hermes.default_model);
    
    // Note: ESP-IDF Settings::Set* returns void, so we can't check per-field success.
    // NVS commit happens on Settings destructor. If NVS is full, writes silently fail.
    // TODO: Consider adding nvs_commit() + error check if NVS reliability becomes an issue.
}

void StackchanExConfig::Print() {
    ex_config_s config = Load();
    
    ESP_LOGI(TAG, "=== Stack-chan Extended Config ===");
    ESP_LOGI(TAG, "backend: %d (%s)", config.backend, 
             config.backend == BACKEND_OPENCLAW ? "OpenClaw" : "Hermes");
    ESP_LOGI(TAG, "websocket_url: %s", config.websocket_url.c_str());
    ESP_LOGI(TAG, "openclaw: host=%s port=%d agent=%s model=%s",
             config.openclaw.host.c_str(), config.openclaw.port,
             config.openclaw.agent_id.c_str(), config.openclaw.default_model.c_str());
    ESP_LOGI(TAG, "hermes: host=%s port=%d agent=%s model=%s",
             config.hermes.host.c_str(), config.hermes.port,
             config.hermes.agent_id.c_str(), config.hermes.default_model.c_str());
    ESP_LOGI(TAG, "===================================");
}