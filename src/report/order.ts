import type { PageKey } from '../app/store';

export const LOG_ORDER: [Exclude<PageKey, 'explorer' | 'compare' | 'pdiff'>, string][] = [
  ['overview', 'Overview'], ['tracking', 'Tracking'], ['actuators', 'Actuators'], ['vibration', 'Vibration'], ['filters', 'Gyro filters'],
  ['rateloop', 'Rate loop'], ['power', 'Power'], ['sensors', 'GPS & estimator'], ['system', 'System'], ['params', 'Parameters'], ['messages', 'Messages & events'],
];
