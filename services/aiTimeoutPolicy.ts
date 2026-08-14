import type { SpeedMode } from '../types';

/** Request limits after the 50% reliability increase requested for every mode. */
export const REQUEST_TIMEOUT_MS_BY_SPEED_MODE: Readonly<Record<SpeedMode, number>> = {
  fast: 180_000,
  ultra: 180_000,
  'ultra-max': 270_000,
};

export const DEFAULT_AI_ATTEMPT_TIMEOUT_MS = 90_000;
export const AUXILIARY_REQUEST_TIMEOUT_MS = 45_000;
export const RESPONSE_BODY_IDLE_TIMEOUT_MS = 67_500;
export const FAST_LOW_PROGRESS_TIMEOUT_MS = 135_000;

export const requestTimeoutForSpeedMode = (mode: SpeedMode | undefined): number =>
  REQUEST_TIMEOUT_MS_BY_SPEED_MODE[mode || 'fast'];
