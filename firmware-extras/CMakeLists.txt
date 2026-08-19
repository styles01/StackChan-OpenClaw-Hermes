# firmware-extras/CMakeLists.txt — ESP-IDF component for OpenClaw/Hermes config layer
idf_component_register(
    SRCS
        "stackchan_ex_config.cc"
        "web_config_endpoints.cc"
        "strip_emoji.cc"
    INCLUDE_DIRS
        "."
        "../firmware/xiaozhi-esp32/main"
    PRIV_REQUIRES
        nvs_flash
        esp_http_server
        json
)
# NOTE: 'main' removed from PRIV_REQUIRES to avoid circular dependency
# settings.h is resolved via INCLUDE_DIRS pointing to xiaozhi-esp32/main