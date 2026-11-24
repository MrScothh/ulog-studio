# Gyro filters

Before the rate controller uses the gyro, PX4 filters it. Each filter removes noise that would otherwise reach the motors (heat, wasted energy, twitching), and each one adds **delay**, which costs stability margin in the rate loop. This page shows what PX4 does to the gyro signal on your vehicle, what every filter costs, whether it is doing useful work on this flight, and what other settings would change.

## What PX4 does (v1.17 and newer)

The chain lives in `src/modules/sensors/vehicle_angular_velocity/VehicleAngularVelocity.cpp` and has not changed from v1.17 to the current `main`. For every raw sample of the **gyro the controller uses** (the one selected in `sensor_selection`), at that gyro's raw rate:

```
gyro ─► dynamic notches ─► notch NF0 ─► notch NF1 ─► low-pass ──────────────► P and I terms
        (ESC RPM, FFT)     IMU_GYRO_NF0_*  NF1_*     IMU_GYRO_CUTOFF
                                                     (2nd order)
                                                        │
                                                        └─► derivative ─► low-pass ─► D term
                                                                          IMU_DGYRO_CUTOFF
                                                                          (1st order)
```

- Notches: `math::NotchFilter` (bandwidth = width of the notch in Hz). A notch is off when its frequency is 0 or above half the sample rate.
- Gyro low-pass: `math::LowPassFilter2p`, a 2nd-order Butterworth.
- D term: the derivative is taken **after** the gyro low-pass, then filtered by a **first-order** `AlphaFilter`. The D term therefore carries the delay of every filter above plus its own.
- Dynamic notches (`IMU_GYRO_DNF_EN`): bit 0 follows the ESC RPM (`IMU_GYRO_DNF_HMC` harmonics, width `IMU_GYRO_DNF_BW`, never below `IMU_GYRO_DNF_MIN`); bit 1 follows the peaks found by the onboard FFT (`gyro_fft` module, `IMU_GYRO_FFT_EN`). On the page they are modelled at their **hover** frequency.
- The filters run at the raw rate of the gyro in use (`vehicle_imu_status.gyro_raw_rate_hz`), which can differ from other IMUs on the same board: a second IMU sampling at 8 kHz does not matter if the controller uses a 2 kHz one.

## Reading the page

**At a glance** draws the chain with the delay each block adds at 10 Hz (the region where multicopter rate loops cross over). For scale, the PX4 tuning guide gives about 8 / 3.8 / 1.9 ms for a gyro low-pass at 30 / 60 / 120 Hz; the page reproduces those numbers.

**Checks** (problems first):

- *Notch on a peak?* For each static notch: the strongest vibration peaks of the raw gyro in quiet hover and how many dB the notch removes from the nearest one.
  - removes ≥ 10 dB: the notch is earning its delay;
  - removes only a few dB: it is off the peak, the page tells you where the peak is;
  - no peak nearby: it adds delay for nothing; move it or disable it (frequency 0).
- *Peak not notched:* a strong peak no notch covers, with how much the low-pass already attenuates it.
- *Model checks* (with the raw FIFO logged): the page replays the chain on the raw gyro and compares the result with what PX4 itself computed in flight: the filtered rate (`vehicle_angular_velocity`), the D-term input (`vehicle_angular_velocity.xyz_derivative`) and the torque command (`vehicle_torque_setpoint`). Typical agreement is a few percent; if it is much worse, the logged parameters are not what flew (changed in flight) or the log is unusual.
- Notes on dynamic notches (for example `IMU_GYRO_DNF_EN` asking for the FFT notch on a firmware without the `gyro_fft` module, where it has no effect) and on a gyro low-pass and D low-pass set far apart.

## Trying other values

Edit the notch frequencies and widths, the gyro low-pass and the D low-pass. The gyro of this flight is filtered again with the new values:

- **Delay** before P/I and before D at 10 Hz, now and proposed.
- **Noise sent to the motors**: RMS of `MC_*RATE_K · (P · filtered rate + D · filtered derivative)` above 30 Hz, in percent of full torque command, now and proposed. With the raw FIFO this is exact (and checked against the logged torque); without it the page uses `sensor_combined`, which is sampled far below the filter rate, so treat the numbers as indicative.
- Noise spectra of the gyro and of the torque command, now and proposed, with the logged torque for comparison.

*Export changed (.params)* writes only the parameters you changed to a QGroundControl `.params` file. ULog Studio never writes to a vehicle.

By default the replay uses quiet hover; *Use the zoomed time range* replays the part of the flight zoomed on the timeline instead.

## A tuning recipe (from the PX4 guide)

1. Fly with the high-rate profile and the raw FIFO (`SDLOG_PROFILE` = 273, see [Logging setup](Logging-setup.md)).
2. Put notches on the peaks the page finds (rotor frequency and its harmonics, frame resonances). A notch that sits on nothing should go.
3. Raise `IMU_GYRO_CUTOFF` as long as the noise sent to the motors stays acceptable; then the same for `IMU_DGYRO_CUTOFF`. Keep them within a factor of about 4 of each other.
4. Fly the new values (short flights, check motor temperature) and compare the logs on [Compare flights](Compare-and-parameter-diff.md).
5. Use the saved delay on the [Rate loop](Rate-loop.md) page: less delay allows higher rate gains.

Do not fix a vibrating airframe with filters: balance props, stiffen arms and mounts first.

## Advanced

*Filter frequency response* (collapsed) has the exact attenuation, phase and delay of the rate and D paths, now and proposed, and a table of phase lag at 1–20 Hz.
