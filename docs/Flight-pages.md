# Flight pages

Each page is a list of collapsible sections; the *Jump to* buttons at the top scroll to a section (and open it if it was collapsed). Every time chart shares the timeline zoom and cursor; each chart can be enlarged, saved as PNG or exported as CSV from its corner buttons.

## Overview

- **Summary**: duration, distance, speeds, tilt, current, and the **automatic checks**: firmware older than v1.17, corrupt data, logger dropouts, vibration level, aliasing risk, motor imbalance and saturation, CPU load, failsafes, error events in flight and in the pre-flight checks, hover thrust. A green "no significant issues" when nothing stands out.
- **Trajectory & replay**: map, top-down position and the [flight replay](Timeline-and-replay.md).
- **Vehicle & log**: airframe, hardware, software version, vehicle UUID, battery start/end voltage per pack and **per cell** (measured cells when the battery reports them, otherwise pack voltage divided by `BAT1_N_CELLS`), minimum voltage under load.

## Tracking

- **Attitude & rate tracking**: setpoint vs estimate for roll, pitch, yaw, angular rates (with the rate integral).
- **Position & velocity**: local position and velocity with setpoints; the altitude chart includes a downward rangefinder (lidar) when present, shown as distance + home altitude.
- **Pilot inputs**: RC sticks and switches.
- **Rate step response (PID analysis)**: the step response of each rate loop deconvolved from the flight data (PID-Analyzer method), with rise time and overshoot.

## Actuators

- **Actuator controls**: torque and thrust commands, and their FFT.
- **Motor & servo outputs**, ESC RPM when logged.
- **Motor imbalance**: each motor's deviation from the mean in quiet hover, turned into a centre-of-gravity offset and a residual yaw torque using the `CA_ROTORn_*` geometry, and the time spent saturated.

## Vibration

- **Vibration levels**: the accelerometer vibration metric, raw accelerometer and gyro.
- **Quiet-hover spectra**: gyro and accelerometer spectra on *quiet hover* only (airborne, sticks centred, speed below 2.5 m/s, with an adaptive stick threshold), so that manoeuvres do not mask the vibration.
- **Aliasing check**: warns when a topic is logged below twice the vibration frequency.
- **FFT (whole log)**, **Spectrograms** (accelerometer, angular rate and acceleration) and **High-rate IMU (FIFO)** when the raw FIFO is logged.

## Power

- **Power**: battery voltage, current, consumed capacity, temperatures.
- **Hover thrust normalised on voltage**: hover thrust corrected for the battery voltage and its drift during the flight (a rising value at constant voltage hints at a tired battery or motors).

## GPS & estimator

- **GPS readiness at arming**: fix type, satellites, EPH/EPV, the EKF2 GPS checks and when GNSS fusion started relative to arming; jamming and spoofing indicators.
- **GPS**: uncertainty, noise and jamming over the flight.
- **Estimator (EKF2)**: status flags that changed (with times), innovation test ratios.
- **Magnetometer & distance**: field strength, thrust vs field (a sign of motor current interference), distance sensor.

## System

- **CPU & sampling**: CPU and RAM load, sampling regularity.
- **Loop timing**: gyro → torque latency, interval percentiles per loop (logger dropouts excluded).
- **Logged topics & rates**: every topic with its logged rate.
- **Logger dropouts** and **Performance counters & boot log**.
