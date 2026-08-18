// CoreS3 camera driver for StackChan-OpenClaw-Hermes
// GC0308 camera on shared I2C bus (GPIO12 SDA / GPIO11 SCL)
// External 20MHz XCLK (NOT LEDC — causes audio choppy per 3 reference repos)
// Init/deinit per capture pattern from stackchan-gemini-firmware
//
// CRITICAL: Camera shares I2C bus with system peripherals.
// Must release M5Unified I2C before init, deinit after capture.
// XCLK = -1 (external clock) — do NOT generate via LEDC.

#ifndef CORES3_CAMERA_H
#define CORES3_CAMERA_H

#include "esp_err.h"
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// GC0308 camera pin config (confirmed by stackchan-mcp + stackchan-gemini-firmware)
// Two repos agree on SDA=GPIO12/SCL=GPIO11 — robot-bridge is the outlier
#define CORES3_CAM_PIN_SIOD     GPIO_NUM_12  // I2C SDA (shared with system bus)
#define CORES3_CAM_PIN_SIOC     GPIO_NUM_11  // I2C SCL (shared with system bus)
#define CORES3_CAM_PIN_XCLK     (-1)         // External 20MHz clock — NOT LEDC
#define CORES3_CAM_PIN_D7       GPIO_NUM_47
#define CORES3_CAM_PIN_D6       GPIO_NUM_48
#define CORES3_CAM_PIN_D5       GPIO_NUM_16
#define CORES3_CAM_PIN_D4       GPIO_NUM_15
#define CORES3_CAM_PIN_D3       GPIO_NUM_42
#define CORES3_CAM_PIN_D2       GPIO_NUM_41
#define CORES3_CAM_PIN_D1       GPIO_NUM_40
#define CORES3_CAM_PIN_D0       GPIO_NUM_39
#define CORES3_CAM_PIN_VSYNC    GPIO_NUM_46
#define CORES3_CAM_PIN_HREF     GPIO_NUM_38
#define CORES3_CAM_PIN_PCLK     GPIO_NUM_45
#define CORES3_CAM_XCLK_FREQ    20000000     // 20MHz external

#define CORES3_CAM_WIDTH        320
#define CORES3_CAM_HEIGHT       240

// Initialize camera hardware (acquires I2C bus)
// Must be paired with cores3_camera_deinit() — do NOT leave camera always-on
esp_err_t cores3_camera_init(void);

// Deinitialize camera hardware (releases I2C bus for other peripherals)
void cores3_camera_deinit(void);

// Capture a single JPEG frame
// out_buffer must be freed by caller with free()
// Returns JPEG bytes in *out, length in *len
esp_err_t cores3_camera_capture_jpeg(uint8_t **out, size_t *len);

// Capture and return base64-encoded JPEG (for HTTP/MCP transport)
// out_string must be freed by caller with free()
esp_err_t cores3_camera_capture_base64(char **out_string);

// Status
bool cores3_camera_ready(void);
bool cores3_camera_enabled(void);
const char *cores3_camera_last_error(void);

#ifdef __cplusplus
}
#endif

#endif // CORES3_CAMERA_H