// web_config_endpoints.cc — HTTP GET/POST /config for device config editing
// Ported from plaipin's web config pattern to ESP-IDF esp_http_server
#include <esp_http_server.h>
#include <esp_log.h>
#include <cJSON.h>
#include "web_config_endpoints.h"
#include "stackchan_ex_config.h"
#include "settings.h"

static const char* TAG = "WebConfig";
static httpd_handle_t server_handle = nullptr;

static esp_err_t config_get_handler(httpd_req_t* req) {
    ex_config_s config = StackchanExConfig::Load();
    
    cJSON* root = cJSON_CreateObject();
    cJSON* oc = cJSON_CreateObject();
    cJSON_AddStringToObject(oc, "host", config.openclaw.host.c_str());
    cJSON_AddNumberToObject(oc, "port", config.openclaw.port);
    cJSON_AddStringToObject(oc, "agent_id", config.openclaw.agent_id.c_str());
    cJSON_AddStringToObject(oc, "default_model", config.openclaw.default_model.c_str());
    cJSON_AddItemToObject(root, "openclaw", oc);
    
    cJSON* hm = cJSON_CreateObject();
    cJSON_AddStringToObject(hm, "host", config.hermes.host.c_str());
    cJSON_AddNumberToObject(hm, "port", config.hermes.port);
    cJSON_AddStringToObject(hm, "agent_id", config.hermes.agent_id.c_str());
    cJSON_AddStringToObject(hm, "default_model", config.hermes.default_model.c_str());
    cJSON_AddItemToObject(root, "hermes", hm);
    
    cJSON_AddNumberToObject(root, "backend", config.backend);
    cJSON_AddStringToObject(root, "websocket_url", config.websocket_url.c_str());
    cJSON_AddBoolToObject(root, "start_ai_on_boot", config.start_ai_on_boot);
    
    char* json_str = cJSON_PrintUnformatted(root);
    httpd_resp_set_type(req, "application/json");
    httpd_resp_sendstr(req, json_str);
    
    cJSON_free(json_str);
    cJSON_Delete(root);
    return ESP_OK;
}

static esp_err_t config_post_handler(httpd_req_t* req) {
    // Read body
    int total_len = req->content_len;
    if (total_len > 4096) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Payload too large");
        return ESP_FAIL;
    }
    
    char* buf = (char*)calloc(1, total_len + 1);
    if (!buf) {
        httpd_resp_send_500(req);
        return ESP_FAIL;
    }
    
    int received = 0;
    while (received < total_len) {
        int ret = httpd_req_recv(req, buf + received, total_len - received);
        if (ret <= 0) {
            free(buf);
            httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Failed to receive body");
            return ESP_FAIL;
        }
        received += ret;
    }
    buf[total_len] = '\0';
    
    cJSON* root = cJSON_Parse(buf);
    free(buf);
    
    if (!root) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Invalid JSON");
        return ESP_FAIL;
    }
    
    ex_config_s config = StackchanExConfig::Load();  // Load existing, only overwrite provided fields
    
    cJSON* oc = cJSON_GetObjectItem(root, "openclaw");
    if (oc) {
        cJSON* item;
        item = cJSON_GetObjectItem(oc, "host");
        if (item && cJSON_IsString(item)) config.openclaw.host = item->valuestring;
        item = cJSON_GetObjectItem(oc, "port");
        if (item && cJSON_IsNumber(item)) config.openclaw.port = item->valueint;
        item = cJSON_GetObjectItem(oc, "agent_id");
        if (item && cJSON_IsString(item)) config.openclaw.agent_id = item->valuestring;
        item = cJSON_GetObjectItem(oc, "default_model");
        if (item && cJSON_IsString(item)) config.openclaw.default_model = item->valuestring;
    }
    
    cJSON* hm = cJSON_GetObjectItem(root, "hermes");
    if (hm) {
        cJSON* item;
        item = cJSON_GetObjectItem(hm, "host");
        if (item && cJSON_IsString(item)) config.hermes.host = item->valuestring;
        item = cJSON_GetObjectItem(hm, "port");
        if (item && cJSON_IsNumber(item)) config.hermes.port = item->valueint;
        item = cJSON_GetObjectItem(hm, "agent_id");
        if (item && cJSON_IsString(item)) config.hermes.agent_id = item->valuestring;
        item = cJSON_GetObjectItem(hm, "default_model");
        if (item && cJSON_IsString(item)) config.hermes.default_model = item->valuestring;
    }
    
    cJSON* backend_item = cJSON_GetObjectItem(root, "backend");
    if (backend_item && cJSON_IsNumber(backend_item)) config.backend = backend_item->valueint;
    
    cJSON* ws_url_item = cJSON_GetObjectItem(root, "websocket_url");
    if (ws_url_item && cJSON_IsString(ws_url_item)) config.websocket_url = ws_url_item->valuestring;
    
    cJSON* boot_item = cJSON_GetObjectItem(root, "start_ai_on_boot");
    if (boot_item && cJSON_IsBool(boot_item)) config.start_ai_on_boot = cJSON_IsTrue(boot_item);
    
    StackchanExConfig::Save(config);
    
    // Also write the WebSocket URL into the "websocket" NVS namespace
    // so the existing xiaozhi protocol code (Application::InitializeProtocol) picks it up.
    // The device reads websocket_settings.GetString("url") and connects directly.
    std::string ws_url;
    if (config.backend == BACKEND_OPENCLAW) {
        // OpenClaw ai-server: WebSocket on port 8765 at /ws
        // (config.port 18789 is the HTTP API port, NOT the WebSocket port)
        char url_buf[256];
        snprintf(url_buf, sizeof(url_buf), "ws://%s:8765/ws", 
                 config.openclaw.host.c_str());
        ws_url = url_buf;
    } else {
        // Hermes backend — also uses port 8765 for WebSocket
        char url_buf[256];
        snprintf(url_buf, sizeof(url_buf), "ws://%s:8765/ws",
                 config.hermes.host.c_str());
        ws_url = url_buf;
    }
    
    // If a custom websocket_url was provided, use that instead
    if (!config.websocket_url.empty()) {
        ws_url = config.websocket_url;
    }
    
    Settings ws_settings("websocket", true);
    ws_settings.SetString("url", ws_url);
    
    // Also write start_ai_on_boot to the "xiaozhi" NVS namespace
    // so the device's getXiaozhiConfig() picks it up and auto-launches the AI Agent
    Settings xiaozhi_settings("xiaozhi", true);
    xiaozhi_settings.SetBool("boot_ai", config.start_ai_on_boot);
    
    cJSON_Delete(root);
    
    httpd_resp_set_type(req, "application/json");
    httpd_resp_sendstr(req, "{\"status\":\"ok\",\"message\":\"Config saved. Reboot to apply.\"}");
    return ESP_OK;
}

static esp_err_t config_html_handler(httpd_req_t* req) {
    httpd_resp_set_type(req, "text/html");
    httpd_resp_sendstr(req,
        "<!DOCTYPE html><html><head><meta charset='utf-8'>"
        "<meta name='viewport' content='width=device-width,initial-scale=1'>"
        "<title>Stack-chan Config</title>"
        "<style>"
        "body{font-family:system-ui;max-width:600px;margin:20px auto;padding:20px}"
        "label{display:block;margin:8px 0 4px;font-weight:bold}"
        "input,select{width:100%;padding:8px;margin-bottom:12px;box-sizing:border-box}"
        "button{padding:12px 24px;font-size:16px;background:#6c5ce7;color:#fff;border:none;border-radius:8px;cursor:pointer}"
        "h2{margin-top:24px;color:#6c5ce7}"
        "</style></head><body>"
        "<h1>🤖 Stack-chan Config</h1>"
        "<form id='cfgForm'>"
        "<label>Backend</label>"
        "<select id='backend'><option value='0'>OpenClaw</option><option value='1'>Hermes</option></select>"
        "<label>WebSocket URL</label>"
        "<input id='websocket_url' placeholder='ws://host:8765/ws'>"
        "<label>Start AI on Boot</label>"
        "<select id='start_ai_on_boot'><option value='false'>No (show launcher)</option><option value='true'>Yes (auto-connect)</option></select>"
        "<h2>OpenClaw</h2>"
        "<label>Host</label><input id='oc_host'>"
        "<label>Port</label><input id='oc_port' type='number' value='18789'>"
        "<label>Agent ID</label><input id='oc_agent_id' value='rosie'>"
        "<label>Default Model</label><input id='oc_default_model' value='openclaw/rosie'>"
        "<h2>Hermes</h2>"
        "<label>Host</label><input id='hm_host'>"
        "<label>Port</label><input id='hm_port' type='number' value='8643'>"
        "<label>Agent ID</label><input id='hm_agent_id' value='hermes'>"
        "<label>Default Model</label><input id='hm_default_model' value='hermes/venus'>"
        "<button type='button' onclick='save()'>Save Config</button>"
        "</form>"
        "<script>"
        "async function load(){const r=await fetch('/config');const d=await r.json();"
        "document.getElementById('backend').value=d.backend;"
        "document.getElementById('websocket_url').value=d.websocket_url||'';"
        "document.getElementById('start_ai_on_boot').value=d.start_ai_on_boot||false;"
        "document.getElementById('oc_host').value=d.openclaw.host||'';"
        "document.getElementById('oc_port').value=d.openclaw.port||18789;"
        "document.getElementById('oc_agent_id').value=d.openclaw.agent_id||'rosie';"
        "document.getElementById('oc_default_model').value=d.openclaw.default_model||'openclaw/rosie';"
        "document.getElementById('hm_host').value=d.hermes.host||'';"
        "document.getElementById('hm_port').value=d.hermes.port||8643;"
        "document.getElementById('hm_agent_id').value=d.hermes.agent_id||'hermes';"
        "document.getElementById('hm_default_model').value=d.hermes.default_model||'hermes/venus';}"
        "async function save(){"
        "const d={backend:+document.getElementById('backend').value,"
        "websocket_url:document.getElementById('websocket_url').value,"
        "start_ai_on_boot:document.getElementById('start_ai_on_boot').value==='true',"
        "openclaw:{host:document.getElementById('oc_host').value,"
        "port:+document.getElementById('oc_port').value,"
        "agent_id:document.getElementById('oc_agent_id').value,"
        "default_model:document.getElementById('oc_default_model').value},"
        "hermes:{host:document.getElementById('hm_host').value,"
        "port:+document.getElementById('hm_port').value,"
        "agent_id:document.getElementById('hm_agent_id').value,"
        "default_model:document.getElementById('hm_default_model').value}};"
        "const r=await fetch('/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)});"
        "alert(await r.text());}"
        "load();"
        "</script></body></html>");
    return ESP_OK;
}

void web_config_start() {
    if (server_handle) return;
    
    httpd_config_t config = HTTPD_DEFAULT_CONFIG();
    config.server_port = 80;
    config.max_uri_handlers = 4;
    config.uri_match_fn = NULL;
    config.lru_purge_enable = true;
    config.stack_size = 16384;
    
    if (httpd_start(&server_handle, &config) != ESP_OK) {
        ESP_LOGE(TAG, "Failed to start web config server");
        return;
    }
    
    // GET /config — JSON config
    httpd_uri_t config_get = {
        .uri = "/config",
        .method = HTTP_GET,
        .handler = config_get_handler,
    };
    httpd_register_uri_handler(server_handle, &config_get);
    
    // POST /config — save config
    httpd_uri_t config_post = {
        .uri = "/config",
        .method = HTTP_POST,
        .handler = config_post_handler,
    };
    httpd_register_uri_handler(server_handle, &config_post);
    
    // GET / — web config editor HTML
    httpd_uri_t root_get = {
        .uri = "/",
        .method = HTTP_GET,
        .handler = config_html_handler,
    };
    httpd_register_uri_handler(server_handle, &root_get);
    
    ESP_LOGI(TAG, "Web config server started on port 80");
}