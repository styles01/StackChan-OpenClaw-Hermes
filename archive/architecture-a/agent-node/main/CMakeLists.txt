idf_component_register(
    SRCS
        "main.c"
        "board_cores3/cores3_display.c"
        "board_cores3/cores3_audio.c"
        "board_cores3/cores3_touch.c"
        # Phase 2 files (cores3_servo.c, cores3_camera.c, cores3_led.c) excluded —
        # from-scratch implementations pending replacement with thin wrappers
        # around proven Stack-chan libraries (M5StackChan.Motion, esp_camera, etc.)
        # See analysis/adversarial-doc-critique.md for details
    INCLUDE_DIRS
        "."
        "board_cores3"
    REQUIRES
        av_render
        console
        esp-openclaw-node
        esp-openclaw-node-provisioning
        esp-openclaw-room-node
        esp-openclaw-talk
        esp_event
        esp_driver_gpio
        esp_driver_i2c
        esp_driver_spi
        esp_driver_i2s
        esp_lcd
        esp_netif
        esp_peer
        esp_webrtc
        esp_wifi
        espressif__esp_codec_dev
        freertos
        lvgl__lvgl
        media_lib_utils)