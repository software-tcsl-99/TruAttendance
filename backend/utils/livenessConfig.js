const VALID_MODES = new Set(['off', 'log', 'enforce']);
let warnedInvalidMode = false;

function getLivenessMode() {
  const configuredMode = (process.env.LIVENESS_MODE || 'off').trim().toLowerCase();
  if (VALID_MODES.has(configuredMode)) {
    return configuredMode;
  }

  if (!warnedInvalidMode) {
    console.warn(`[Liveness] Invalid LIVENESS_MODE "${configuredMode}", defaulting to off.`);
    warnedInvalidMode = true;
  }
  return 'off';
}

module.exports = { getLivenessMode };
