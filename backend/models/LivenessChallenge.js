const mongoose = require('mongoose');

const LivenessChallengeSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  nonce: {
    type: String,
    required: true,
  },
  steps: {
    type: [String],
    required: true,
  },
  purpose: {
    type: String,
    enum: ['punchIn', 'punchOut'],
    required: true,
  },
  expiresAt: {
    type: Date,
    required: true,
  },
  usedAt: {
    type: Date,
    default: null,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

LivenessChallengeSchema.index({ nonce: 1 }, { unique: true });
LivenessChallengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('LivenessChallenge', LivenessChallengeSchema);
