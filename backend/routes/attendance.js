const express = require('express');
const rateLimit = require('express-rate-limit');
const {
  punchIn,
  punchOut,
  createLivenessChallenge,
  getHistory,
  getAllAttendance,
  trackLocation,
  getMonthlyView,
  toggleBreak,
  trackBatch,
  adminEditAttendance,
  gpsStatusUpdate,
  uploadPunchSelfie
} = require('../controllers/attendance');

const router = express.Router();

const { protect, authorize } = require('../middleware/auth');

router.use(protect);

const livenessChallengeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  keyGenerator: (req) => String(req.user?._id || req.user?.id || 'authenticated-user'),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    code: 'LIVENESS_RATE_LIMITED',
    message: 'Too many verification attempts. Please wait and try again.',
  },
});

router.post('/liveness/challenge', livenessChallengeLimiter, createLivenessChallenge);
router.post('/punch-in', punchIn);
router.post('/punch-out', punchOut);
router.post('/upload-selfie', uploadPunchSelfie);
router.post('/break', toggleBreak);
router.get('/history', getHistory);
router.get('/monthly-view', getMonthlyView);
router.post('/track', trackLocation);
router.post('/track-batch', trackBatch);
router.post('/gps-status', gpsStatusUpdate);
router.get('/', authorize('admin'), getAllAttendance);

// Admin-only: edit any attendance record directly
router.put('/admin-edit/:attendanceId', authorize('admin'), adminEditAttendance);

module.exports = router;
