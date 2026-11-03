const mongoose = require('mongoose');

const AttendanceSchema = new mongoose.Schema({
  companyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: [true, 'Attendance must belong to a company'],
    index: true,
  },
  user: {
    type: mongoose.Schema.ObjectId,
    ref: 'User',
    required: true,
  },
  date: {
    type: Date,
    required: true,
  },
  punchIn: {
    time: Date,
    location: {
      latitude: Number,
      longitude: Number,
      address: String,
    },
    selfie: String,
    liveness: {
      status: { type: String, enum: ['verified', 'missing', 'invalid', 'skipped_mode'] },
      reason: String,
      steps: [String],
      platform: String,
      appVersion: String,
      verifiedAt: Date,
      challengeId: { type: mongoose.Schema.Types.ObjectId, ref: 'LivenessChallenge' },
    },
    isOutside: { type: Boolean, default: false }
  },
  punchOut: {
    time: Date,
    location: {
      latitude: Number,
      longitude: Number,
      address: String,
    },
    selfie: String,
    liveness: {
      status: { type: String, enum: ['verified', 'missing', 'invalid', 'skipped_mode'] },
      reason: String,
      steps: [String],
      platform: String,
      appVersion: String,
      verifiedAt: Date,
      challengeId: { type: mongoose.Schema.Types.ObjectId, ref: 'LivenessChallenge' },
    },
    isOutside: { type: Boolean, default: false },
    isAutoPunchOut: { type: Boolean, default: false }
  },
  isAutoPunchOut: {
    type: Boolean,
    default: false
  },
  breaks: [{
    startTime: Date,
    endTime: Date,
    duration: Number // minutes
  }],
  status: {
    type: String,
    enum: ['Present', 'Late', 'Half Day', 'Absent', 'Leave', 'Leave(Half)', 'Holiday', 'Week Off', 'Neutral'],
    default: 'Absent',
  },
  workingHours: {
    type: Number,
    default: 0,
  },
  lateTime: {
    type: Number,
    default: 0,
  },
  isLate: {
    type: Boolean,
    default: false,
  },
  isHalfDay: {
    type: Boolean,
    default: false,
  },
  isManualOverride: {
    type: Boolean,
    default: false,
  },
  halfDaySession: {
    type: String,
    enum: ['Session 1', 'Session 2', null],
    default: null,
  },
  isOutside: {
    type: Boolean,
    default: false,
  },
  distance: {
    type: Number,
    default: 0,
  },
  // ──────────────────────────────────────────────────────────────────
  // NOTE: trackingLogs embedded array has been REMOVED (2026-06-30).
  // All GPS points are now stored exclusively in RawTrackingPoint.
  // This fixes: MongoDB 16MB limit, race conditions, full-recalc,
  // address-update races, and heavy report payloads.
  // ──────────────────────────────────────────────────────────────────
  totalDistance: {
    type: Number,
    default: 0
  },
  currentDistance: {
    type: Number,
    default: 0
  },
  trackingPointCount: {
    type: Number,
    default: 0
  },
  firstTrackedLocation: {
    latitude: Number,
    longitude: Number,
    time: Date,
    address: String
  },
  lastTrackedLocation: {
    latitude: Number,
    longitude: Number,
    time: Date,
    address: String
  },
  lastTrackingTime: Date,
  battery: {
    type: Number,
    default: 100
  },
  signalStatus: {
    type: String,
    enum: ['online', 'offline'],
    default: 'online'
  },
  // Outstation Status Tracking (>= 150 km from working location)
  isOutstation: {
    type: Boolean,
    default: false,
    index: true,
  },
  outstationDistanceKm: {
    type: Number,
    default: 0,
  },
  outstationDetectedAt: {
    type: Date,
    default: null,
  },
  // Sticky history for expense eligibility: isOutstation is cleared when the employee
  // returns, wasOutstation stays true for the day once outstation was detected.
  wasOutstation: {
    type: Boolean,
    default: false,
  },
  outstationReturnedAt: {
    type: Date,
    default: null,
  },
  shiftInfo: {
    name: String,
    startTime: String, // HH:mm
    endTime: String,   // HH:mm
    requiredHours: Number,
    gracePeriod: Number,
    halfDayAfter: String,
    firstSession: {
      startTime: String,
      endTime: String,
    },
    secondSession: {
      startTime: String,
      endTime: String,
    }
  }
}, {
  timestamps: true,
  versionKey: false
});

// Index for quick search
AttendanceSchema.index({ companyId: 1, user: 1, date: 1 });
AttendanceSchema.index({ companyId: 1, date: -1 });

module.exports = mongoose.model('Attendance', AttendanceSchema);
