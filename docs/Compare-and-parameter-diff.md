# Compare and parameter diff

Both pages use every log open in the window, plus any QGroundControl `.params` file you drop.

## Compare flights

The same metrics on every flight, in one table:

- firmware, airborne time, time per flight mode;
- filters (`IMU_GYRO_NF0/NF1`, `IMU_GYRO_CUTOFF`, `IMU_DGYRO_CUTOFF`) and rate gains (K/P/I/D);
- quiet-hover vibration (30–75 Hz) and oscillation (2–6 Hz) on roll and pitch, accelerometer vibration, dominant vibration frequency;
- hover thrust, also normalised on battery voltage, mean battery voltage, quiet tilt (a wind proxy), maximum tilt;
- motor deviation per motor and saturation;
- attitude error RMS in quiet hover;
- logger dropouts, controller topics' logged rate, CPU load.

Vibration and tracking are measured on quiet hover only, so manoeuvres do not skew the comparison. The roll and pitch gyro spectra of all flights are overlaid.

Typical use: fly the same manoeuvre with different filters or gains and see which log is quieter or tracks better.

## Parameter diff

Parameters that differ between the selected logs and `.params` files, side by side with their descriptions. Calibration values and counters (`CAL_*`, flight-time counters, UUIDs) are left out. *Include parameters missing from some sets* also lists parameters present in only some of the sets (for example between firmware versions).
