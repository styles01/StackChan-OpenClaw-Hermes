// CoreS3 camera driver for StackChan-OpenClaw-Hermes
// GC0308 camera — init/deinit per capture pattern
// CRITICAL: Camera shares I2C bus (GPIO12/GPIO11) with system peripherals.
// Must release I2C before init, deinit after capture. XCLK = external (NOT LEDC).

#include "cores3_camera.h"
#include "esp_log.h"
#include "esp_check.h"
#include <string.h>

#if defined(ENABLE_CAMERA)
#include "esp_camera.h"
#include "img_converters.h"
#include "mbedtls/base64.h"

static camera_config_t s_camera_config = {
    .pin_pwdn = -1,
    .pin_reset = -1,
    .pin_xclk = CORES3_CAM_PIN_XCLK,        // -1 = external 20MHz clock
    .pin_sccb_sda = CORES3_CAM_PIN_SIOD,     // GPIO12 (shared with system I2C)
    .pin_sccb_scl = CORES3_CAM_PIN_SIOC,     // GPIO11 (shared with system I2C)
    .pin_d7 = CORES3_CAM_PIN_D7,
    .pin_d6 = CORES3_CAM_PIN_D6,
    .pin_d5 = CORES3_CAM_PIN_D5,
    .pin_d4 = CORES3_CAM_PIN_D4,
    .pin_d3 = CORES3_CAM_PIN_D3,
    .pin_d2 = CORES3_CAM_PIN_D2,
    .pin_d1 = CORES3_CAM_PIN_D1,
    .pin_d0 = CORES3_CAM_PIN_D0,
    .pin_vsync = CORES3_CAM_PIN_VSYNC,
    .pin_href = CORES3_CAM_PIN_HREF,
    .pin_pclk = CORES3_CAM_PIN_PCLK,
    .xclk_freq_hz = CORES3_CAM_XCLK_FREQ,
    .ledc_timer = LEDC_TIMER_0,      // Unused when XCLK=-1, but struct requires it
    .ledc_channel = LEDC_CHANNEL_0,  // Unused when XCLK=-1
    .pixel_format = PIXFORMAT_RGB565,
    .frame_size = FRAMESIZE_QVGA,    // 320x240
    .jpeg_quality = 12,
    .fb_count = 1,
    .fb_location = CAMERA_FB_IN_PSRAM,
    .grab_mode = CAMERA_GRAB_LATEST,
};

static bool s_camera_active = false;
static char s_last_error[64] = "not_started";
#endif

esp_err_t cores3_camera_init(void)
{
#if defined(ENABLE_CAMERA)
    if (s_camera_active) return ESP_OK;

    // CRITICAL: Release I2C bus before camera init — camera and system
    // peripherals share GPIO12/GPIO11. Without this, camera init corrupts
    // the AW88298/ES7210/AXP2101 codec state.
    // TODO Phase 2: implement I2C bus release (need M5Unified or direct I2C release)
    // M5.In_I2C.release();  // Arduino pattern — need ESP-IDF equivalent

    esp_err_t err = esp_camera_init(&s_camera_config);
    if (err != ESP_OK) {
        snprintf(s_last_error, sizeof(s_last_error), "init_failed:%d", (int)err);
        ESP_LOGE(TAG, "Camera init failed: %s (0x%x)", esp_err_to_name(err), (int)err);
        return err;
    }

    // Disable hmirror/vflip for correct orientation
    sensor_t *sensor = esp_camera_sensor_get();
    if (sensor) {
        sensor->set_hmirror(sensor, 0);
        sensor->set_vflip(sensor, 0);
    }

    s_camera_active = true;
    s_last_error[0] = '\0';
    ESP_LOGI(TAG, "Camera initialized: GC0308 %dx%d RGB565, XCLK=external",
             CORES3_CAM_WIDTH, CORES3_CAM_HEIGHT);
    return ESP_OK;
#else
    ESP_LOGW(TAG, "Camera not enabled (ENABLE_CAMERA not defined)");
    return ESP_ERR_NOT_SUPPORTED;
#endif
}

void cores3_camera_deinit(void)
{
#if defined(ENABLE_CAMERA)
    if (!s_camera_active) return;
    esp_camera_deinit();
    s_camera_active = false;
    // TODO Phase 2: re-acquire I2C bus for system peripherals
    ESP_LOGI(TAG, "Camera deinitialized — I2C bus released for system use");
#endif
}

esp_err_t cores3_camera_capture_jpeg(uint8_t **out, size_t *len)
{
#if defined(ENABLE_CAMERA)
    if (!s_camera_active) {
        return ESP_ERR_INVALID_STATE;
    }
    ESP_RETURN_ON_FALSE(out != NULL && len != NULL, ESP_ERR_INVALID_ARG, TAG, "args required");

    camera_fb_t *fb = esp_camera_fb_get();
    if (fb == NULL) {
        snprintf(s_last_error, sizeof(s_last_error), "fb_get_failed");
        return ESP_FAIL;
    }

    // GC0308 outputs RGB565 — convert to JPEG
    uint8_t *jpeg_buf = NULL;
    size_t jpeg_len = 0;
    bool ok = frame2jpg(fb, 12, &jpeg_buf, &jpeg_len);
    esp_camera_fb_return(fb);

    if (!ok || jpeg_buf == NULL || jpeg_len == 0) {
        snprintf(s_last_error, sizeof(s_last_error), "jpeg_convert_failed");
        free(jpeg_buf);
        return ESP_FAIL;
    }

    *out = jpeg_buf;
    *len = jpeg_len;
    ESP_LOGI(TAG, "Captured JPEG: %d bytes", (int)jpeg_len);
    return ESP_OK;
#else
    return ESP_ERR_NOT_SUPPORTED;
#endif
}

esp_err_t cores3_camera_capture_base64(char **out_string)
{
#if defined(ENABLE_CAMERA)
    uint8_t *jpeg = NULL;
    size_t jpeg_len = 0;
    esp_err_t err = cores3_camera_capture_jpeg(&jpeg, &jpeg_len);
    if (err != ESP_OK) return err;

    // Base64 encode
    size_t b64_len = 0;
    mbedtls_base64_encode(NULL, 0, &b64_len, jpeg, jpeg_len);
    char *b64 = malloc(b64_len + 1);
    if (b64 == NULL) {
        free(jpeg);
        return ESP_ERR_NO_MEM;
    }
    size_t written = 0;
    int ret = mbedtls_base64_encode((unsigned char *)b64, b64_len, &written, jpeg, jpeg_len);
    free(jpeg);
    if (ret != 0) {
        free(b64);
        snprintf(s_last_error, sizeof(s_last_error), "base64_failed");
        return ESP_FAIL;
    }
    b64[written] = '\0';
    *out_string = b64;
    ESP_LOGI(TAG, "Captured base64 JPEG: %d chars", (int)written);
    return ESP_OK;
#else
    return ESP_ERR_NOT_SUPPORTED;
#endif
}

bool cores3_camera_ready(void)
{
#if defined(ENABLE_CAMERA)
    return s_camera_active;
#else
    return false;
#endif
}

bool cores3_camera_enabled(void)
{
#if defined(ENABLE_CAMERA)
    return true;
#else
    return false;
#endif
}

const char *cores3_camera_last_error(void)
{
#if defined(ENABLE_CAMERA)
    return s_last_error;
#else
    return "not_enabled";
#endif
}