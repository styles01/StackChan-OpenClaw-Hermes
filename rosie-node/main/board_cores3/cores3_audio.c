// CoreS3 audio driver for Rosie Node
// AW88298 speaker + ES7210 mic with TDM I2S for AEC reference
// Adapted from StackChan firmware cores3_audio_codec.cc

#include "cores3_board.h"
#include "esp_log.h"
#include "esp_check.h"
#include "esp_codec_dev_defaults.h"
#include "driver/i2c_master.h"
#include "driver/i2s_tdm.h"
#include "driver/i2s_std.h"

#define TAG "cores3_audio"

static i2c_master_bus_handle_t s_i2c_bus = NULL;

// Initialize I2C bus (shared by all CoreS3 peripherals)
esp_err_t cores3_i2c_init(void)
{
    if (s_i2c_bus != NULL) {
        return ESP_OK;  // Already initialized
    }
    i2c_master_bus_config_t bus_config = {
        .i2c_port = CORES3_I2C_PORT,
        .sda_io_num = CORES3_I2C_SDA,
        .scl_io_num = CORES3_I2C_SCL,
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .glitch_ignore_cnt = 7,
        .intr_priority = 0,
        .trans_queue_depth = 10,
        .flags = { .enable_internal_pullup = true },
    };
    ESP_RETURN_ON_ERROR(i2c_new_master_bus(&bus_config, &s_i2c_bus), TAG, "I2C bus init");
    ESP_LOGI(TAG, "I2C bus initialized on port %d (SDA=%d, SCL=%d)",
             CORES3_I2C_PORT, CORES3_I2C_SDA, CORES3_I2C_SCL);
    return ESP_OK;
}

i2c_master_bus_handle_t cores3_i2c_get_handle(void)
{
    return s_i2c_bus;
}

esp_err_t cores3_audio_open(void *ctx, esp_openclaw_room_audio_handles_t *handles)
{
    (void)ctx;
    ESP_RETURN_ON_FALSE(handles != NULL, ESP_ERR_INVALID_ARG, TAG, "audio handles required");

    // Initialize I2C bus for codec control
    ESP_RETURN_ON_ERROR(cores3_i2c_init(), TAG, "I2C init");

    // Create I2S channels (TX for speaker, RX for mic)
    i2s_chan_handle_t tx = NULL;
    i2s_chan_handle_t rx = NULL;
    i2s_chan_config_t channel_cfg = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
    channel_cfg.auto_clear = true;
    ESP_RETURN_ON_ERROR(i2s_new_channel(&channel_cfg, &tx, &rx), TAG, "I2S channel create");

    // TX: Standard I2S for AW88298 speaker (stereo, 16-bit)
    i2s_std_config_t std_cfg = {
        .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(CORES3_AUDIO_SAMPLE_RATE),
        .slot_cfg = I2S_STD_PHILIP_SLOT_DEFAULT_CONFIG(
            I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO),
        .gpio_cfg = {
            .mclk = CORES3_I2S_MCLK,
            .bclk = CORES3_I2S_BCLK,
            .ws = CORES3_I2S_WS,
            .dout = CORES3_I2S_DOUT,
            .din = I2S_GPIO_UNUSED,
        },
    };
    ESP_RETURN_ON_ERROR(i2s_channel_init_std_mode(tx, &std_cfg), TAG, "I2S TX init (AW88298)");

    // RX: TDM for ES7210 mic with AEC reference channel
    // CoreS3 uses TDM 4-slot to capture MIC1 + reference (MIC3)
    i2s_tdm_config_t tdm_cfg = {
        .clk_cfg = {
            .sample_rate_hz = CORES3_AUDIO_SAMPLE_RATE,
            .clk_src = I2S_CLK_SRC_DEFAULT,
            .mclk_multiple = I2S_MCLK_MULTIPLE_256,
            .bclk_div = 8,
        },
        .slot_cfg = {
            .data_bit_width = I2S_DATA_BIT_WIDTH_16BIT,
            .slot_bit_width = I2S_SLOT_BIT_WIDTH_AUTO,
            .slot_mode = I2S_SLOT_MODE_STEREO,
            .slot_mask = (i2s_tdm_slot_mask_t)(I2S_TDM_SLOT0 | I2S_TDM_SLOT1 | I2S_TDM_SLOT2 | I2S_TDM_SLOT3),
            .ws_width = I2S_TDM_AUTO_WS_WIDTH,
            .ws_pol = false,
            .bit_shift = true,
            .left_align = false,
            .big_endian = false,
            .bit_order_lsb = false,
            .skip_mask = false,
            .total_slot = I2S_TDM_AUTO_SLOT_NUM,
        },
        .gpio_cfg = {
            .mclk = CORES3_I2S_MCLK,
            .bclk = CORES3_I2S_BCLK,
            .ws = CORES3_I2S_WS,
            .dout = I2S_GPIO_UNUSED,
            .din = CORES3_I2S_DIN,
        },
    };
    ESP_RETURN_ON_ERROR(i2s_channel_init_tdm_mode(rx, &tdm_cfg), TAG, "I2S RX init (ES7210 TDM)");

    // Enable channels
    ESP_RETURN_ON_ERROR(i2s_channel_enable(tx), TAG, "I2S TX enable");
    ESP_RETURN_ON_ERROR(i2s_channel_enable(rx), TAG, "I2S RX enable");

    // Create codec data interface
    audio_codec_i2s_cfg_t data_cfg = {
        .port = I2S_NUM_0,
        .rx_handle = rx,
        .tx_handle = tx,
    };
    const audio_codec_data_if_t *data = audio_codec_new_i2s_data(&data_cfg);
    ESP_RETURN_ON_FALSE(data != NULL, ESP_ERR_NO_MEM, TAG, "I2S codec data interface");

    // AW88298 speaker codec
    audio_codec_i2c_cfg_t speaker_ctrl_cfg = {
        .port = CORES3_I2C_PORT,
        .addr = AW88298_CODEC_DEFAULT_ADDR,
        .bus_handle = s_i2c_bus,
    };
    const audio_codec_ctrl_if_t *speaker_ctrl = audio_codec_new_i2c_ctrl(&speaker_ctrl_cfg);
    ESP_RETURN_ON_FALSE(speaker_ctrl != NULL, ESP_ERR_NO_MEM, TAG, "AW88298 control interface");

    const audio_codec_gpio_if_t *gpio = audio_codec_new_gpio();
    ESP_RETURN_ON_FALSE(gpio != NULL, ESP_ERR_NO_MEM, TAG, "codec GPIO interface");

    aw88298_codec_cfg_t aw88298_cfg = {
        .ctrl_if = speaker_ctrl,
        .gpio_if = gpio,
        .reset_pin = GPIO_NUM_NC,
        .hw_gain = {
            .pa_voltage = 5.0,
            .codec_dac_voltage = 3.3,
            .pa_gain = 1,
        },
    };
    const audio_codec_if_t *speaker = aw88298_codec_new(&aw88298_cfg);
    ESP_RETURN_ON_FALSE(speaker != NULL, ESP_ERR_NO_MEM, TAG, "AW88298 codec interface");

    esp_codec_dev_cfg_t speaker_dev = {
        .dev_type = ESP_CODEC_DEV_TYPE_OUT,
        .codec_if = speaker,
        .data_if = data,
    };
    handles->playback = esp_codec_dev_new(&speaker_dev);
    ESP_RETURN_ON_FALSE(handles->playback != NULL, ESP_ERR_NO_MEM, TAG, "AW88298 playback device");

    // ES7210 mic codec
    audio_codec_i2c_cfg_t mic_ctrl_cfg = {
        .port = CORES3_I2C_PORT,
        .addr = ES7210_CODEC_DEFAULT_ADDR,
        .bus_handle = s_i2c_bus,
    };
    const audio_codec_ctrl_if_t *mic_ctrl = audio_codec_new_i2c_ctrl(&mic_ctrl_cfg);
    ESP_RETURN_ON_FALSE(mic_ctrl != NULL, ESP_ERR_NO_MEM, TAG, "ES7210 control interface");

    es7210_codec_cfg_t es7210_cfg = {
        .ctrl_if = mic_ctrl,
        // MIC1 = near-end mic, MIC3 = speaker reference for AEC
        .mic_selected = ES7210_SEL_MIC1 | ES7210_SEL_MIC3,
    };
    const audio_codec_if_t *mic = es7210_codec_new(&es7210_cfg);
    ESP_RETURN_ON_FALSE(mic != NULL, ESP_ERR_NO_MEM, TAG, "ES7210 codec interface");

    esp_codec_dev_cfg_t mic_dev = {
        .dev_type = ESP_CODEC_DEV_TYPE_IN,
        .codec_if = mic,
        .data_if = data,
    };
    handles->record = esp_codec_dev_new(&mic_dev);
    ESP_RETURN_ON_FALSE(handles->record != NULL, ESP_ERR_NO_MEM, TAG, "ES7210 capture device");

    ESP_LOGI(TAG, "Audio initialized: AW88298 speaker + ES7210 mic (TDM, MIC1+MIC3 for AEC)");
    return ESP_OK;
}