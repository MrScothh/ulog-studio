# Rate loop

The rate controller is the innermost loop: it turns the angular-rate error into torque commands. If it has too little stability reserve the vehicle rings or oscillates, and a bit more payload, a fuller battery or more filtering can push it over the edge. This page measures how much reserve each axis has on your airframe, from the flight itself.

## How it works

1. **Airframe.** During stick doublets the log shows how hard the vehicle accelerates for a given torque command. The page fits, per axis,

   `angular acceleration = K · e^(−s·d) / (τ·s + 1) · torque command`

   - `K`: control effectiveness (rad/s² per unit of torque command);
   - `τ`: how fast motors and propellers follow (time constant);
   - `d`: pure delay before anything happens (computation, mixer, output protocol, ESC).

   The angular velocity in the log is the *filtered* one, so PX4's gyro filters (exactly as on the [Gyro filters](Gyro-filters.md) page) are part of the fit: `K`, `τ` and `d` describe the airframe alone, and the filters can be changed afterwards without approximation.

2. **Controller.** PX4's rate controller is added the way the firmware computes it (`src/lib/rate_control/rate_control.cpp`, `src/modules/mc_rate_control/MulticopterRateControl.cpp`):

   `torque = MC_*RATE_K · (P · error + I · ∫error − D · filtered derivative of the rate) + FF · rate setpoint`

   P, I and D are all multiplied by `MC_*RATE_K`; D acts on the measurement, not on the error; on yaw the torque then goes through the `MC_YAW_TQ_CUTOFF` low-pass (2 Hz by default).

3. **Margins.** From the loop the page computes:
   - **phase margin**: how much extra phase lag (delay) the loop tolerates before it oscillates, also given in milliseconds;
   - **gain margin**: how much the loop gain can grow before it oscillates, and at which frequency it would;
   - **peak sensitivity**: how much disturbances are amplified at the worst frequency.

## Reading the verdict

| Phase margin | Gain margin | Verdict |
|---|---|---|
| ≥ 45° | ≥ 6 dB | good stability reserve |
| 30–45° | 4–6 dB | little reserve: ringing, sensitive to payload and battery |
| < 30° | < 4 dB | close to oscillating |

The details say, in numbers, what would make the loop oscillate ("at about 9 Hz with 1.6× the current loop gain, or with 19 ms of extra delay"), and which `MC_*RATE_K` would meet 45° / 6 dB with the same P/I/D ratio, or how much room there is.

## Can the model be trusted?

The fitted airframe, your gains and your filters predict how the vehicle should follow the rate setpoint. The page compares that prediction with the response **measured in the log** (gain and phase, only at frequencies where the measurement is clean):

- within about 3 dB / 20°: the model reproduces the flight and the margins are meaningful;
- larger differences: wind, saturation, mixed manoeuvres or too little excitation; treat the margins as indicative or pick a cleaner window;
- fit R² below 0.8: not enough clean stick input on that axis, no verdict.

The *Identified airframe* table lists `K`, `τ`, `d`, R² and the closed-loop match per axis.

## What you need in the log

- High-rate logging (`SDLOG_PROFILE` bit 4): `vehicle_angular_velocity` and `vehicle_torque_setpoint` at 100 Hz or more.
- A few sharp stick doublets per axis (see [Logging setup](Logging-setup.md)). The page finds them automatically; to use another stretch, zoom on it in the timeline and press **Use zoom range** for that axis.

## Trying other gains

Edit `K`, `P`, `I`, `D` per axis: the margins update, the airframe model stays the one identified on this flight. *Export changed (.params)* writes the changed gains for QGroundControl; nothing is sent to the vehicle.

## What raises the margins

- **Lower `MC_*RATE_K`** (scales P, I and D together): more margin, slower response.
- **Less delay**: higher gyro filter cutoffs where the noise allows, no notch that sits on nothing ([Gyro filters](Gyro-filters.md)); DShot instead of PWM and motor outputs on the flight controller (AUX/FMU) rather than through the IO chip, as the PX4 tuning guide suggests.
- **More D** damps the loop, at the price of more noise to the motors.

Always change gains in small steps (20–30 %, then 5–10 %) and check a new flight.

## Advanced

*Loop frequency response* (collapsed): margins in detail (crossover, delay margin, peak sensitivity, margins as flown vs with the edited gains), open-loop Bode plots, disturbance amplification `|S|`, and the list of stick doublets found.

## Validation

The loop computation is checked in the test suite against a closed-form case and, on a reference flight, against an independent Python/scipy implementation of the same equations (identical margins to 0.1°). The filter model is checked against PX4's own outputs (see [Gyro filters](Gyro-filters.md)).
