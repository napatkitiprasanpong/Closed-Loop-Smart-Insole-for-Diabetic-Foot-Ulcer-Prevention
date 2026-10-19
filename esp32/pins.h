// Pin map for the closed-loop insole controller board (ESP32-S3-WROOM-1-N8)
// Generated from the schematic netlist. Do not edit by hand.
#pragma once

#define PIN_FSR_ADC      1
#define PIN_NTC_ADC      2
#define PIN_AUX_ADC      4
#define PIN_ACT_SENSE    5
#define PIN_AUX_IO       6
#define PIN_LED_STATUS   7
#define PIN_I2C_SDA      8
#define PIN_I2C_SCL      9
#define PIN_MUX_S0       10
#define PIN_MUX_S1       11
#define PIN_MUX_S2       12
#define PIN_MUX_S3       13
#define PIN_MUX_EN_N     14
#define PIN_FILL1        15
#define PIN_FILL2        16
#define PIN_FILL3        17
#define PIN_FILL4        18
#define PIN_VENT1        21
#define PIN_VENT2        38
#define PIN_VENT3        39
#define PIN_VENT4        40
#define PIN_PUMP_PWM     41
#define PIN_BUZZER       42

// Multiplexer: write the channel index (0-15) to S0..S3 (S0 = LSB), wait about 0.3 ms, then read.
// MUX_EN_N is active low and is pulled high at reset (muxes disabled).
// FSR channels 0-15 -> FSR_ADC; NTC channels 0-7 -> NTC_ADC (read together).

// Valve outputs are active high (low-side MOSFETs). All outputs are off at reset (100k pull-downs).
// PUMP_PWM: use LEDC at about 20 kHz.
// ACT_SENSE: V_ACT through a 10k/15k divider, so V_ACT = pin voltage / 0.6 (5 V gives about 3.0 V at the pin; calibrate the ADC).

