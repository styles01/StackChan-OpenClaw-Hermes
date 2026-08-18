// CoreS3 touch/input driver for Rosie Node
// FT6336 capacitive touch + BOOT button
// Adapted from StackChan firmware touch handling

#include "cores3_board.h"
#include "esp_log.h"
#include "esp_check.h"
#include "driver/gpio.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#define TAG "cores3_touch"

static void (*s_toggle_view)(void) = NULL;

static void boot_button_task(void *arg)
{
    (void)arg;
    bool was_pressed = false;
    for (;;) {
        bool pressed = gpio_get_level(GPIO_NUM_0) == 0;
        if (pressed && !was_pressed && s_toggle_view != NULL) {
            s_toggle_view();
        }
        was_pressed = pressed;
        vTaskDelay(pdMS_TO_TICKS(60));
    }
}

esp_err_t cores3_setup_local_input(void *ctx, void (*toggle_view)(void))
{
    (void)ctx;
    // BOOT button on GPIO0 (same as Waveshare, standard ESP32-S3)
    const gpio_config_t io = {
        .pin_bit_mask = 1ULL << GPIO_NUM_0,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
    };
    ESP_RETURN_ON_ERROR(gpio_config(&io), TAG, "BOOT button GPIO");

    s_toggle_view = toggle_view;

    TaskHandle_t task = NULL;
    BaseType_t result = xTaskCreate(
        boot_button_task,
        "boot_btn",
        2560,
        NULL,
        4,
        &task);
    ESP_RETURN_ON_FALSE(result == pdPASS, ESP_ERR_NO_MEM, TAG, "button task create");

    ESP_LOGI(TAG, "BOOT button input initialized");
    return ESP_OK;
}

// TODO: FT6336 touch driver — the StackChan firmware polls it via I2C at 20ms
// intervals using an esp_timer. For v1 we can skip touch and just use the BOOT
// button. Add FT6336 in Phase 2 when we wire up the full robot layer.