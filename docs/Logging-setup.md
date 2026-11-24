# Logging setup

What PX4 writes to the log is set by `SDLOG_PROFILE`, a bitmask. Change it in QGroundControl before the flight; it applies from the next arming.

| Bit | Value | Profile | Needed for |
|---|---|---|---|
| 0 | 1 | Default set | every page |
| 4 | 16 | High rate (RC, attitude, rates, actuators) | step response, [Rate loop](Rate-loop.md), actuator FFT |
| 8 | 256 | Raw FIFO high-rate IMU (gyro) | exact [Gyro filters](Gyro-filters.md) replay, vibration up to the gyro Nyquist |
| 3 | 8 | System identification | optional, more actuator/IMU data |
| 1 | 2 | Estimator replay | EKF2 replay (not used by ULog Studio) |

## Recommended values

- **Everyday flying:** `1` (default).
- **Tuning flight:** `17` (default + high rate). Lets the [Rate loop](Rate-loop.md) page identify the airframe and compute margins (it needs `vehicle_angular_velocity` and `vehicle_torque_setpoint` at 100 Hz or more).
- **Filter tuning flight:** `273` (default + high rate + raw gyro FIFO). The [Gyro filters](Gyro-filters.md) page then replays PX4's filter chain on the real gyro samples and checks itself against what PX4 computed in flight. FIFO logs are large and add logger load: keep these flights short (30–60 s of hover with some stick doublets is enough) and switch back afterwards.

## A good tuning flight

1. Take off in Stabilized or Acro, hover for 20–30 s with the sticks centred (quiet hover: used for vibration and noise).
2. On each axis, a few sharp **stick doublets**: quick full deflection one way, the other way, back to centre. Wait a couple of seconds between them. These are what the [Rate loop](Rate-loop.md) page uses to identify the airframe.
3. Land and disarm, so each test ends up in its own log.

Low wind helps: gusts look like stick inputs the controller did not ask for.

## Aliasing

A topic logged below twice the vibration frequency shows that vibration at a false, lower frequency (44 Hz vibration logged at 50 Hz looks like a 6 Hz oscillation). The Vibration page warns when this can happen; the cure is the high-rate profile.
