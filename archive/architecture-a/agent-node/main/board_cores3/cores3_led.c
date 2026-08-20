// CoreS3 LED + emotion controller for StackChan-OpenClaw-Hermes
// WS2812C ×12 LEDs via AW9523 IO expander
// 10-mode emotion state machine from stackchan-gemini-firmware
// LED state machine from robot-bridge (idle=off, wake=green, think=rainbow, reply=blue)
//
// Phase 2 skeleton — hardware driver needs AW9523 IO expander init first.
// The AW9523 provides the WS2812 data line enable + backlight PWM.

#include "cores3_led.h"
#include "esp_log.h"
#include <string.h>

#define TAG "cores3_led"

static cores3_emotion_t s_emotion = CORES3_EMOTION_NEUTRAL;
static cores3_led_state_t s_led_state = CORES3_LED_OFF;
static bool s_initialized = false;
static uint32_t s_last_frame_ms = 0;
static uint16_t s_frame = 0;

esp_err_t cores3_led_init(void)
{
    // TODO Phase 2: init AW9523 IO expander via I2C
    // The AW9523 controls:
    //   - WS2812C LED data line enable
    //   - Display backlight PWM
    //   - ILI9342 reset
    //
    // AW9523 I2C address: 0x3E (typically, need to verify for CoreS3)
    // After init, enable WS2812 data line and set initial LED state to OFF

    s_initialized = true;
    s_emotion = CORES3_EMOTION_NEUTRAL;
    s_led_state = CORES3_LED_OFF;
    ESP_LOGI(TAG, "LED controller initialized (Phase 2 skeleton — AW9523 TODO)");
    return ESP_OK;
}

esp_err_t cores3_led_set_emotion(cores3_emotion_t emotion)
{
    if (!s_initialized) return ESP_ERR_INVALID_STATE;
    s_emotion = emotion;

    // Map emotion to LED state (simplified from robot-bridge's 4-state machine)
    switch (emotion) {
        case CORES3_EMOTION_NEUTRAL:
        case CORES3_EMOTION_SLEEP:
            s_led_state = CORES3_LED_OFF;
            break;
        case CORES3_EMOTION_LISTENING:
            s_led_state = CORES3_LED_WAKE;  // green
            break;
        case CORES3_EMOTION_THINKING:
        case CORES3_EMOTION_LOOKING:
            s_led_state = CORES3_LED_THINK;  // rainbow chase
            break;
        case CORES3_EMOTION_SPEAKING:
        case CORES3_EMOTION_HAPPY:
        case CORES3_EMOTION_FOUND:
            s_led_state = CORES3_LED_REPLY;  // blue
            break;
        case CORES3_EMOTION_ANGRY:
        case CORES3_EMOTION_ERROR:
            s_led_state = CORES3_LED_REPLY;  // blue (could be red for error)
            break;
    }

    ESP_LOGD(TAG, "Emotion set to %s, LED state %d",
             cores3_led_emotion_name(emotion), s_led_state);
    return ESP_OK;
}

esp_err_t cores3_led_set_state(cores3_led_state_t state)
{
    if (!s_initialized) return ESP_ERR_INVALID_STATE;
    s_led_state = state;
    return ESP_OK;
}

void cores3_led_loop(void)
{
    if (!s_initialized) return;

    uint32_t now = esp_timer_get_time() / 1000;  // ms
    if (now - s_last_frame_ms < 50) return;  // 20fps max for LED animation
    s_last_frame_ms = now;
    s_frame++;

    // TODO Phase 2: actual LED animation via WS2812 driver
    // For now, just track animation state so it's ready to wire up

    switch (s_led_state) {
        case CORES3_LED_OFF:
            // All LEDs off
            break;
        case CORES3_LED_WAKE:
            // Solid green for 1.8s after wake, then off
            if (s_frame > 36) {  // 36 * 50ms = 1.8s
                s_led_state = CORES3_LED_OFF;
            }
            break;
        case CORES3_LED_THINK:
            // Rainbow chase animation — 12 LEDs, hue rotation
            // TODO: compute HSV → RGB for each LED based on s_frame
            break;
        case CORES3_LED_REPLY:
            // Solid blue while speaking
            break;
    }
}

cores3_emotion_t cores3_led_current_emotion(void) { return s_emotion; }
cores3_led_state_t cores3_led_current_state(void) { return s_led_state; }

const char *cores3_led_emotion_name(cores3_emotion_t emotion)
{
    switch (emotion) {
        case CORES3_EMOTION_NEUTRAL:   return "neutral";
        case CORES3_EMOTION_LISTENING: return "listening";
        case CORES3_EMOTION_SPEAKING:  return "speaking";
        case CORES3_EMOTION_THINKING:  return "thinking";
        case CORES3_EMOTION_LOOKING:   return "looking";
        case CORES3_EMOTION_HAPPY:     return "happy";
        case CORES3_EMOTION_ANGRY:     return "angry";
        case CORES3_EMOTION_FOUND:     return "found";
        case CORES3_EMOTION_ERROR:     return "error";
        case CORES3_EMOTION_SLEEP:     return "sleep";
        default: return "unknown";
    }
}