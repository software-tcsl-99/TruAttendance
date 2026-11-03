const { randomBytes, randomInt } = require("crypto");
const LivenessChallenge = require("../models/LivenessChallenge");
const { getLivenessMode } = require("../utils/livenessConfig");

const ALLOWED_STEPS = [
  "turn-left",
  "turn-right",
  "look-up",
  "look-down",
  "blink",
  "nod",
];
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

function createRandomSteps() {
  while (true) {
    const steps = [...ALLOWED_STEPS];
    for (let index = steps.length - 1; index > 0; index -= 1) {
      const swapIndex = randomInt(index + 1);
      [steps[index], steps[swapIndex]] = [steps[swapIndex], steps[index]];
    }

    const selected = steps.slice(0, randomInt(3, 5));
    const hasNod = selected.includes("nod");
    const hasLook =
      selected.includes("look-up") || selected.includes("look-down");
    if (!hasNod || !hasLook) {
      return selected;
    }
  }
}

async function createLivenessChallenge({
  userId,
  purpose,
  ChallengeModel = LivenessChallenge,
  now = new Date(),
}) {
  const expiresAt = new Date(now.getTime() + CHALLENGE_TTL_MS);
  const challenge = await ChallengeModel.create({
    userId,
    nonce: randomBytes(32).toString("base64url"),
    steps: createRandomSteps(),
    purpose,
    expiresAt,
    usedAt: null,
    createdAt: now,
  });

  return {
    nonce: challenge.nonce,
    steps: challenge.steps,
    expiresAt: challenge.expiresAt,
  };
}

function failedValidation(code, message) {
  return { valid: false, code, message };
}

function sameUserId(left, right) {
  return String(left?._id || left) === String(right?._id || right);
}

function sameSteps(completedSteps, issuedSteps) {
  return (
    Array.isArray(completedSteps) &&
    completedSteps.length === issuedSteps.length &&
    completedSteps.every((step, index) => step === issuedSteps[index])
  );
}

async function validateAndConsumeLiveness({
  userId,
  purpose,
  liveness,
  ChallengeModel = LivenessChallenge,
  now = new Date(),
}) {
  if (liveness == null) {
    return failedValidation(
      "LIVENESS_REQUIRED",
      "Live attendance verification is required.",
    );
  }

  if (
    typeof liveness !== "object" ||
    Array.isArray(liveness) ||
    typeof liveness.nonce !== "string" ||
    liveness.nonce.length < 32 ||
    liveness.nonce.length > 128 ||
    !Array.isArray(liveness.completedSteps)
  ) {
    return failedValidation(
      "LIVENESS_INVALID",
      "Live attendance verification is invalid. Please retake your selfie.",
    );
  }

  const challenge = await ChallengeModel.findOne({
    nonce: liveness.nonce,
  }).lean();
  if (
    !challenge ||
    !sameUserId(challenge.userId, userId) ||
    challenge.purpose !== purpose
  ) {
    return failedValidation(
      "LIVENESS_INVALID",
      "Live attendance verification does not match this user or action.",
    );
  }

  if (new Date(challenge.expiresAt).getTime() <= now.getTime()) {
    return failedValidation(
      "LIVENESS_EXPIRED",
      "Live attendance verification expired. Please retake your selfie.",
    );
  }

  if (challenge.usedAt) {
    return failedValidation(
      "LIVENESS_REPLAYED",
      "Live attendance verification was already used. Please retake your selfie.",
    );
  }

  if (!sameSteps(liveness.completedSteps, challenge.steps)) {
    return failedValidation(
      "LIVENESS_INVALID",
      "Live attendance steps did not match. Please retake your selfie.",
    );
  }

  // This proves that a server-issued challenge was used once and blocks replay and casual bypass,
  // but not a modified client; face matching and device integrity are separate later phases.
  const consumed = await ChallengeModel.findOneAndUpdate(
    {
      _id: challenge._id,
      userId,
      purpose,
      usedAt: null,
      expiresAt: { $gt: now },
    },
    { $set: { usedAt: now } },
    { new: true },
  ).lean();

  if (!consumed) {
    const latestChallenge = await ChallengeModel.findOne({
      _id: challenge._id,
    }).lean();
    if (latestChallenge?.usedAt) {
      return failedValidation(
        "LIVENESS_REPLAYED",
        "Live attendance verification was already used. Please retake your selfie.",
      );
    }
    if (
      latestChallenge &&
      new Date(latestChallenge.expiresAt).getTime() <= now.getTime()
    ) {
      return failedValidation(
        "LIVENESS_EXPIRED",
        "Live attendance verification expired. Please retake your selfie.",
      );
    }
    return failedValidation(
      "LIVENESS_INVALID",
      "Live attendance verification is invalid. Please retake your selfie.",
    );
  }

  return {
    valid: true,
    challengeId: challenge._id,
    completedSteps: [...challenge.steps],
    platform:
      typeof liveness.platform === "string"
        ? liveness.platform.slice(0, 40)
        : undefined,
    appVersion:
      typeof liveness.appVersion === "string"
        ? liveness.appVersion.slice(0, 80)
        : undefined,
    verifiedAt: now,
  };
}

function isInvalidEnforcedSelfie(selfie) {
  if (typeof selfie !== "string" || !selfie.trim()) {
    return true;
  }

  const value = selfie.trim().toLowerCase();
  return (
    value === "skipped" ||
    value === "pending_background_upload" ||
    value.startsWith("file://") ||
    value.startsWith("content://")
  );
}

async function evaluatePunchLiveness({
  userId,
  purpose,
  liveness,
  selfie,
  ChallengeModel = LivenessChallenge,
  now = new Date(),
}) {
  const mode = getLivenessMode();
  if (mode === "off") {
    return { accepted: true, record: undefined };
  }

  if (mode === "enforce" && isInvalidEnforcedSelfie(selfie)) {
    return {
      accepted: false,
      code:
        typeof selfie === "string" && selfie.trim()
          ? "LIVENESS_INVALID"
          : "LIVENESS_REQUIRED",
      message: "A valid selfie is required for attendance verification.",
    };
  }

  let result;
  try {
    result = await validateAndConsumeLiveness({
      userId,
      purpose,
      liveness,
      ChallengeModel,
      now,
    });
  } catch (error) {
    if (mode === "log") {
      console.warn(
        `[Liveness] mode=log purpose=${purpose} user=${userId} status=invalid code=LIVENESS_ERROR message=${error.message}`,
      );
      return {
        accepted: true,
        record: { status: "invalid", reason: "LIVENESS_ERROR" },
      };
    }

    return {
      accepted: false,
      code: "LIVENESS_INVALID",
      message: "Could not verify live attendance. Please try again.",
    };
  }

  if (!result.valid) {
    const record = {
      status: result.code === "LIVENESS_REQUIRED" ? "missing" : "invalid",
      reason: result.code,
      platform:
        typeof liveness?.platform === "string"
          ? liveness.platform.slice(0, 40)
          : undefined,
      appVersion:
        typeof liveness?.appVersion === "string"
          ? liveness.appVersion.slice(0, 80)
          : undefined,
    };

    if (mode === "log") {
      console.warn(
        `[Liveness] mode=log purpose=${purpose} user=${userId} status=${record.status} code=${result.code}`,
      );
      return { accepted: true, record };
    }

    return {
      accepted: false,
      code: result.code,
      message: result.message,
      record,
    };
  }

  return {
    accepted: true,
    record: {
      status: "verified",
      steps: result.completedSteps,
      platform: result.platform,
      appVersion: result.appVersion,
      verifiedAt: result.verifiedAt,
      challengeId: result.challengeId,
    },
  };
}

module.exports = {
  ALLOWED_STEPS,
  CHALLENGE_TTL_MS,
  createRandomSteps,
  createLivenessChallenge,
  validateAndConsumeLiveness,
  evaluatePunchLiveness,
  isInvalidEnforcedSelfie,
};
