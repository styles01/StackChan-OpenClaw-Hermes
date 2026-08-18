// StackChan-OpenClaw-Hermes — main entry point
// Connects M5Stack Stack-chan (CoreS3) to OpenClaw Gateway or Hermes Agent
//
// Architecture:
//   esp-openclaw-node core → WebSocket to Gateway (port 18789)
//   esp-openclaw-room-node → voice (WebRTC Talk), face, canvas
//   CoreS3 board port → AW88298 speaker, ES7210 mic, ILI9342 display
//
// The robot does zero LLM/STT/TTS locally — all intelligence lives on the Gateway.
// Dual-target: swap connection layer for Hermes Agent (same firmware, different config).

#include "cores3_board.h"
#include "esp_openclaw_room_node.h"
#include "esp_log.h"
#include "esp_err.h"

#define TAG "stackchan_node"

void app_main(void)
{
    ESP_LOGI(TAG, "StackChan-OpenClaw-Hermes starting up — CoreS3 (M5Stack Stack-chan)");

    // Fill the board port config struct
    // This is the contract between esp-openclaw-room-node and our CoreS3 board
    const esp_openclaw_room_node_config_t config = {
        .display_name = "Rosie Node",
        .model_identifier = "m5stack-cores3-rosie",

        // Display: ILI9342 320x240 SPI
        .display = {
            .start = cores3_display_start,
            .setup_local_input = cores3_setup_local_input,
            .lock = cores3_display_lock,
            .unlock = cores3_display_unlock,
            .set_brightness = cores3_display_set_brightness,
            .native_width = CORES3_DISPLAY_WIDTH,
            .native_height = CORES3_DISPLAY_HEIGHT,
            .safe_inset = 0,  // No rounded corners on Stack-chan
            .animated_face = true,
            .animation_frame_ms = 16,  // 60 Hz refresh
        },

        // Audio: AW88298 speaker + ES7210 mic with TDM I2S for AEC
        .audio = {
            .open = cores3_audio_open,
            // "MR" = mic + reference layout (AEC with speaker reference on MIC3)
            .afe_layout = "MR",
            .record_channels = 2,  // MIC1 + reference
            .channel_mask = 0x3,   // channels 0 and 1
            .playback_volume = 100,
            .configure_input_gain = true,
            .input_gain_db = CORES3_AUDIO_INPUT_GAIN_DB,
        },
    };

    // Start the room node — this handles everything:
    //   WebSocket connection to Gateway, WebRTC Talk, wake word, face, canvas
    esp_err_t err = esp_openclaw_room_node_start(&config);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to start room node: %s", esp_err_to_name(err));
        return;
    }

    ESP_LOGI(TAG, "Rosie Node is live. Say 'Hi ESP' to wake, then talk to Rosie.");
}