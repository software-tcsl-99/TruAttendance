const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CHALLENGE_TTL_MS,
  createRandomSteps,
  createLivenessChallenge,
  validateAndConsumeLiveness,
  evaluatePunchLiveness,
} = require('../services/attendanceLivenessService');
const { getLivenessMode } = require('../utils/livenessConfig');
const Attendance = require('../models/Attendance');
const LivenessChallenge = require('../models/LivenessChallenge');

function createFakeChallengeModel(initial = []) {
  const records = new Map(initial.map((record) => [record._id, { ...record }]));
  return {
    records,
    async create(record) {
      const created = { ...record, _id: `challenge-${records.size + 1}` };
      records.set(created._id, created);
      return created;
    },
    findOne(query) {
      return {
        lean: async () => {
          const record = query.nonce
            ? [...records.values()].find((item) => item.nonce === query.nonce)
            : records.get(query._id);
          return record ? { ...record } : null;
        },
      };
    },
    findOneAndUpdate(filter, update) {
      return {
        lean: async () => {
          const record = records.get(filter._id);
          const expiresAfter = filter.expiresAt.$gt;
          if (
            !record ||
            record.usedAt !== null ||
            String(record.userId) !== String(filter.userId) ||
            record.purpose !== filter.purpose ||
            new Date(record.expiresAt) <= expiresAfter
          ) {
            return null;
          }
          record.usedAt = update.$set.usedAt;
          return { ...record };
        },
      };
    },
  };
}

async function issueFakeChallenge(ChallengeModel, overrides = {}) {
  return createLivenessChallenge({
    userId: 'user-1',
    purpose: 'punchIn',
    ChallengeModel,
    now: new Date('2026-01-01T10:00:00.000Z'),
    ...overrides,
  });
}

test('random challenge contains 3-4 allowed steps and excludes nod with either look step', () => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const steps = createRandomSteps();
    assert.ok(steps.length === 3 || steps.length === 4);
    assert.equal(new Set(steps).size, steps.length);
    assert.ok(steps.every((step) =>
      ['turn-left', 'turn-right', 'look-up', 'look-down', 'blink', 'nod'].includes(step),
    ));
    assert.ok(!(steps.includes('nod') && (steps.includes('look-up') || steps.includes('look-down'))));
  }
});

test('challenge issuance sets a five-minute expiry', async () => {
  const ChallengeModel = createFakeChallengeModel();
  const now = new Date('2026-01-01T10:00:00.000Z');
  const issued = await issueFakeChallenge(ChallengeModel, { now });
  const stored = [...ChallengeModel.records.values()][0];
  assert.equal(issued.nonce, stored.nonce);
  assert.deepEqual(issued.steps, stored.steps);
  assert.equal(issued.expiresAt.getTime() - now.getTime(), CHALLENGE_TTL_MS);
});

test('challenge indexes and attendance liveness paths are additive and optional', () => {
  const indexes = LivenessChallenge.schema.indexes();
  assert.ok(indexes.some(([keys, options]) => keys.nonce === 1 && options.unique));
  assert.ok(indexes.some(([keys, options]) => keys.expiresAt === 1 && options.expireAfterSeconds === 0));
  assert.ok(indexes.some(([keys]) => keys.userId === 1));

  for (const punch of ['punchIn', 'punchOut']) {
    for (const field of ['status', 'reason', 'steps', 'platform', 'appVersion', 'verifiedAt', 'challengeId']) {
      assert.equal(Boolean(Attendance.schema.path(`${punch}.liveness.${field}`)?.isRequired), false);
    }
  }
});

test('valid issued steps are consumed once; a repeated nonce is rejected', async () => {
  const ChallengeModel = createFakeChallengeModel();
  const now = new Date('2026-01-01T10:00:00.000Z');
  const issued = await issueFakeChallenge(ChallengeModel, { now });
  const liveness = {
    nonce: issued.nonce,
    completedSteps: issued.steps,
    platform: 'android',
    appVersion: '1.0.2',
  };
  const first = await validateAndConsumeLiveness({
    userId: 'user-1',
    purpose: 'punchIn',
    liveness,
    ChallengeModel,
    now,
  });
  const second = await validateAndConsumeLiveness({
    userId: 'user-1',
    purpose: 'punchIn',
    liveness,
    ChallengeModel,
    now,
  });

  assert.equal(first.valid, true);
  assert.deepEqual(first.completedSteps, issued.steps);
  assert.equal(first.platform, 'android');
  assert.equal(first.appVersion, '1.0.2');
  assert.equal(second.code, 'LIVENESS_REPLAYED');
});

test('wrong step order is invalid and does not consume the challenge', async () => {
  const ChallengeModel = createFakeChallengeModel();
  const now = new Date('2026-01-01T10:00:00.000Z');
  const issued = await issueFakeChallenge(ChallengeModel, { now });
  const result = await validateAndConsumeLiveness({
    userId: 'user-1',
    purpose: 'punchIn',
    liveness: {
      nonce: issued.nonce,
      completedSteps: [...issued.steps].reverse(),
    },
    ChallengeModel,
    now,
  });

  assert.equal(result.code, 'LIVENESS_INVALID');
  assert.equal([...ChallengeModel.records.values()][0].usedAt, null);
});

test('expired, wrong-user, and wrong-purpose challenges are rejected', async () => {
  const ChallengeModel = createFakeChallengeModel();
  const issued = await issueFakeChallenge(ChallengeModel, {
    now: new Date('2026-01-01T10:00:00.000Z'),
  });
  const liveness = { nonce: issued.nonce, completedSteps: issued.steps };

  const expired = await validateAndConsumeLiveness({
    userId: 'user-1',
    purpose: 'punchIn',
    liveness,
    ChallengeModel,
    now: new Date('2026-01-01T10:06:00.000Z'),
  });
  const wrongUser = await validateAndConsumeLiveness({
    userId: 'user-2',
    purpose: 'punchIn',
    liveness,
    ChallengeModel,
    now: new Date('2026-01-01T10:00:30.000Z'),
  });
  const wrongPurpose = await validateAndConsumeLiveness({
    userId: 'user-1',
    purpose: 'punchOut',
    liveness,
    ChallengeModel,
    now: new Date('2026-01-01T10:00:30.000Z'),
  });

  assert.equal(expired.code, 'LIVENESS_EXPIRED');
  assert.equal(wrongUser.code, 'LIVENESS_INVALID');
  assert.equal(wrongPurpose.code, 'LIVENESS_INVALID');
});

test('feature flag defaults to off and accepts the three documented modes', () => {
  const original = process.env.LIVENESS_MODE;
  delete process.env.LIVENESS_MODE;
  assert.equal(getLivenessMode(), 'off');
  for (const mode of ['off', 'log', 'enforce']) {
    process.env.LIVENESS_MODE = mode;
    assert.equal(getLivenessMode(), mode);
  }
  if (original === undefined) {
    delete process.env.LIVENESS_MODE;
  } else {
    process.env.LIVENESS_MODE = original;
  }
});

test('off mode skips validation; log mode accepts missing proof; enforce rejects it', async () => {
  const original = process.env.LIVENESS_MODE;
  const ChallengeModel = createFakeChallengeModel();
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (message) => warnings.push(message);
  try {
    process.env.LIVENESS_MODE = 'off';
    const off = await evaluatePunchLiveness({
      userId: 'user-1',
      purpose: 'punchIn',
      ChallengeModel,
      now: new Date('2026-01-01T10:00:00.000Z'),
    });
    process.env.LIVENESS_MODE = 'log';
    const logged = await evaluatePunchLiveness({
      userId: 'user-1',
      purpose: 'punchIn',
      ChallengeModel,
      now: new Date('2026-01-01T10:00:00.000Z'),
    });
    process.env.LIVENESS_MODE = 'enforce';
    const enforced = await evaluatePunchLiveness({
      userId: 'user-1',
      purpose: 'punchIn',
      selfie: 'data:image/jpeg;base64,abc',
      ChallengeModel,
      now: new Date('2026-01-01T10:00:00.000Z'),
    });

    assert.equal(off.accepted, true);
    assert.equal(off.record, undefined);
    assert.equal(logged.accepted, true);
    assert.equal(logged.record.status, 'missing');
    assert.equal(enforced.accepted, false);
    assert.equal(enforced.code, 'LIVENESS_REQUIRED');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /status=missing code=LIVENESS_REQUIRED/);
  } finally {
    console.warn = originalWarn;
    if (original === undefined) {
      delete process.env.LIVENESS_MODE;
    } else {
      process.env.LIVENESS_MODE = original;
    }
  }
});

test('log mode records valid proof and accepts invalid proof without rejecting', async () => {
  const original = process.env.LIVENESS_MODE;
  const ChallengeModel = createFakeChallengeModel();
  const now = new Date('2026-01-01T10:00:00.000Z');
  const issued = await issueFakeChallenge(ChallengeModel, { now });
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (message) => warnings.push(message);
  process.env.LIVENESS_MODE = 'log';
  try {
    const verified = await evaluatePunchLiveness({
      userId: 'user-1',
      purpose: 'punchIn',
      liveness: { nonce: issued.nonce, completedSteps: issued.steps, platform: 'ios' },
      selfie: 'data:image/jpeg;base64,abc',
      ChallengeModel,
      now,
    });
    const invalid = await evaluatePunchLiveness({
      userId: 'user-1',
      purpose: 'punchIn',
      liveness: { nonce: 'not-a-server-nonce', completedSteps: [] },
      selfie: 'data:image/jpeg;base64,abc',
      ChallengeModel,
      now,
    });

    assert.equal(verified.accepted, true);
    assert.equal(verified.record.status, 'verified');
    assert.equal(invalid.accepted, true);
    assert.equal(invalid.record.status, 'invalid');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /status=invalid code=LIVENESS_INVALID/);
  } finally {
    console.warn = originalWarn;
    if (original === undefined) {
      delete process.env.LIVENESS_MODE;
    } else {
      process.env.LIVENESS_MODE = original;
    }
  }
});

test('log mode accepts an unexpected database error and records it', async () => {
  const original = process.env.LIVENESS_MODE;
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (message) => warnings.push(message);
  process.env.LIVENESS_MODE = 'log';
  try {
    const result = await evaluatePunchLiveness({
      userId: 'user-1',
      purpose: 'punchIn',
      liveness: { nonce: 'a'.repeat(32), completedSteps: [] },
      selfie: 'data:image/jpeg;base64,abc',
      ChallengeModel: {
        findOne() {
          throw new Error('database unavailable');
        },
      },
      now: new Date('2026-01-01T10:00:00.000Z'),
    });
    assert.equal(result.accepted, true);
    assert.deepEqual(result.record, { status: 'invalid', reason: 'LIVENESS_ERROR' });
    assert.match(warnings[0], /code=LIVENESS_ERROR/);
  } finally {
    console.warn = originalWarn;
    if (original === undefined) {
      delete process.env.LIVENESS_MODE;
    } else {
      process.env.LIVENESS_MODE = original;
    }
  }
});

test('enforce mode rejects an unexpected database error', async () => {
  const original = process.env.LIVENESS_MODE;
  process.env.LIVENESS_MODE = 'enforce';
  try {
    const result = await evaluatePunchLiveness({
      userId: 'user-1',
      purpose: 'punchIn',
      liveness: { nonce: 'a'.repeat(32), completedSteps: [] },
      selfie: 'data:image/jpeg;base64,abc',
      ChallengeModel: {
        findOne() {
          throw new Error('database unavailable');
        },
      },
      now: new Date('2026-01-01T10:00:00.000Z'),
    });
    assert.equal(result.accepted, false);
    assert.equal(result.code, 'LIVENESS_INVALID');
    assert.equal(result.message, 'Could not verify live attendance. Please try again.');
  } finally {
    if (original === undefined) {
      delete process.env.LIVENESS_MODE;
    } else {
      process.env.LIVENESS_MODE = original;
    }
  }
});

test('enforce mode rejects skipped and local-file selfies before consuming a challenge', async () => {
  const original = process.env.LIVENESS_MODE;
  const ChallengeModel = createFakeChallengeModel();
  const issued = await issueFakeChallenge(ChallengeModel);
  const liveness = { nonce: issued.nonce, completedSteps: issued.steps };
  process.env.LIVENESS_MODE = 'enforce';
  try {
    for (const selfie of ['skipped', 'pending_background_upload', 'file:///photo.jpg', 'content://photo']) {
      const result = await evaluatePunchLiveness({
        userId: 'user-1',
        purpose: 'punchIn',
        liveness,
        selfie,
        ChallengeModel,
        now: new Date('2026-01-01T10:00:00.000Z'),
      });
      assert.equal(result.accepted, false);
      assert.equal(result.code, 'LIVENESS_INVALID');
    }
    assert.equal([...ChallengeModel.records.values()][0].usedAt, null);
  } finally {
    if (original === undefined) {
      delete process.env.LIVENESS_MODE;
    } else {
      process.env.LIVENESS_MODE = original;
    }
  }
});
