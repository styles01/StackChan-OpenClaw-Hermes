// web_config_endpoints.h — HTTP config editor for Stack-chan
#pragma once

#ifdef __cplusplus
extern "C" {
#endif

// Start the web config server on port 80.
// Serves GET /config (JSON), POST /config (save), GET / (HTML editor).
void web_config_start(void);

#ifdef __cplusplus
}
#endif