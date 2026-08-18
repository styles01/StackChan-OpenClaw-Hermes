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
#include "esp_openclaw_node.h"
#include "esp_log.h"
#include "esp_err.h"

#define TAG "stackchan_node"

// --- Services port callbacks (Phase 2 stubs) ---

// prepare_runtime: called early in startup, before media/Wi-Fi.
// Phase 2: init AW9523 IO expander for display backlight + LED control
static esp_err_t cores3_prepare_runtime(void *ctx)
{
    (void)ctx;
    ESP_LOGI(TAG, "prepare_runtime: AW9523 IO expander init (Phase 2 TODO)");
    // TODO Phase 2: init AW9523 for backlight PWM + WS2812 LED enable
    return ESP_OK;
}

// prepare_network: called before Wi-Fi init.
// CoreS3 has no Wi-Fi coprocessor — nothing to do here.
static esp_err_t cores3_prepare_network(void *ctx)
{
    (void)ctx;
    ESP_LOGI(TAG, "prepare_network: no Wi-Fi coprocessor on CoreS3");
    return ESP_OK;
}

// register_commands: called to register custom robot commands.
// Phase 2: register rosie.look, rosie.emote, rosie.led, rosie.gesture
static esp_err_t cores3_register_commands(void *ctx, esp_openclaw_node_handle_t node)
{
    (void)ctx;
    (void)node;
    ESP_LOGI(TAG, "register_commands: robot commands (Phase 2 TODO)");
    // TODO Phase 2: register custom commands:
    //   rosie.look <x> <y>    — servo lookAt
    //   rosie.emote <emotion> — set emotion state
    //   rosie.led <state>     — LED state machine
    //   rosie.gesture <name>  — servo gesture (nod/shake/look-around)
    return ESP_OK;
}

void app_main(void)
{
    ESP_LOGI(TAG, "StackChan-OpenClaw-Hermes starting up — CoreS3 (M5Stack Stack-chan)");

    // Fill the board port config struct
    // This is the contract between esp-openclaw-room-node and our CoreS3 board
    const esp_openclaw_room_node_config_t config = {
        .display_name = "Stack-chan",
        .model_identifier = "m5stack-cores3-stackchan",

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

        // Audio: AW88298 speaker + ES7210 mic with STD I2S for AEC
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

        // Services: board-specific runtime/network/command hooks
        .services = {
            .prepare_runtime = cores3_prepare_runtime,
            .prepare_network = cores3_prepare_network,
            .register_commands = cores3_register_commands,
        },

        // Storage: no file commands for Phase 1 (add SD card in Phase 3)
        .storage = { 0 },
    };

    // Start the room node — this handles everything:
    //   WebSocket connection to Gateway, WebRTC Talk, wake word, face, canvas
    esp_err_t err = esp_openclaw_room_node_start(&config);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to start room node: %s", esp_err_to_name(err));
        return;
    }

    ESP_LOGI(TAG, "Stack-chan is live. Say 'Hi ESP' to wake, then talk to your agent.");
}