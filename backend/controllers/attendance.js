const Attendance = require('../models/Attendance');
const User = require('../models/User');
const Location = require('../models/Location');
const Leave = require('../models/Leave');
const { getISTDateComponents, createDateFromIST, getStartOfDayIST, getEndOfDayIST, matchShift } = require('../utils/timezone');
// SINGLE SOURCE OF TRUTH — all calculations via canonical service
const statsService = require('../services/employeeStatsService');
const geoService = require('../services/geoTrackingService');
const Shift = require('../models/Shift');
const { calculateDistance } = require('../utils/geofence');
const { uploadToCloudinary } = require('../config/cloudinary');
const { getGoogleRoadDistance, resolveOutstationDistanceMeters } = require('../utils/googleMaps');
const enterpriseTracking = require('../services/enterpriseTrackingService');
const CompanySetting = require('../models/CompanySetting');
const Holiday = require('../models/Holiday');
const rbac = require('../middleware/rbac');
const { RawTrackingPoint, LiveEmployeeStatus } = require('../models/Tracking');
const { reverseGeocodeAsync } = require('../services/enterpriseTrackingService');
const MobileAppConfig = require('../models/MobileAppConfig');
const { isUserActive, isUserAttendanceBlocked, isUserTrackingBlocked, isCompanyAdminUser, COMPANY_ADMIN_ROLES, COMPANY_ADMIN_ROLE_CODES } = require('../utils/accessControlHelper');
const {
  createLivenessChallenge,
  evaluatePunchLiveness,
} = require('../services/attendanceLivenessService');

exports.createLivenessChallenge = async (req, res) => {
  try {
    const { purpose } = req.body || {};
    if (!['punchIn', 'punchOut'].includes(purpose)) {
      return res.status(400).json({
        success: false,
        code: 'LIVENESS_INVALID',
        message: 'A valid attendance purpose is required.',
      });
    }

    const challenge = await createLivenessChallenge({
      userId: req.user._id || req.user.id,
      purpose,
    });
    return res.status(201).json(challenge);
  } catch (err) {
    console.error('[Liveness] Could not create attendance challenge:', err.message);
    return res.status(500).json({
      success: false,
      code: 'LIVENESS_INVALID',
      message: 'Could not start live attendance verification.',
    });
  }
};

// @desc    Track location batch
// @route   POST /api/attendance/track-batch
// @access  Private
exports.trackBatch = async (req, res, next) => {
  try {
    const { userId, batch } = req.body;
    const io = req.app.get('io');

    const mongoose = require('mongoose');
    let targetUserId = req.user?.id || req.user?._id;
    if (userId && mongoose.Types.ObjectId.isValid(userId) && req.user?.scope === 'GLOBAL') {
      targetUserId = userId;
    }

    const companyId = req.tenant?.companyId || req.companyId || req.user?.companyId || req.user?.company || null;
    const result = await enterpriseTracking.processTrackingBatch(targetUserId, batch, io, companyId);
    res.status(200).json(result);
  } catch (err) {
    console.error('[TrackBatch] Error processing batch:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc    Punch In
// @route   POST /api/attendance/punch-in
// @access  Private
exports.punchIn = async (req, res, next) => {
  try {
    const { latitude, longitude, address, selfie, liveness } = req.body;
    const userId = req.user.id;

    const now = new Date();

    // Parallelize time-consuming operations: DB Queries (Selfie upload moved to background)
    const [officeMain, user, settings, allLocations] = await Promise.all([
      Location.findOne({ companyId: req.tenant.companyId, name: 'Office Main' }).then(loc => loc || Location.findOne({ companyId: req.tenant.companyId })),
      User.findById(userId).populate('shift').populate('workingPlace'),
      CompanySetting.findOne({ companyId: req.tenant.companyId }),
      Location.find({ companyId: req.tenant.companyId })
    ]);

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    let targetDate = getStartOfDayIST(now);
    let matchedShift = null;

    if (user.shift) {
      const matchResult = matchShift(now, user.shift, (now - new Date(user.createdAt)) < (48 * 60 * 60 * 1000));
      if (matchResult.matched) {
        matchedShift = matchResult;
        targetDate = matchResult.date;
      } else if (matchResult.closestFutureShift) {
        // Allow employee to punch in at any time on a new day for their upcoming shift
        matchedShift = {
          shiftStart: matchResult.closestFutureShift,
          shiftEnd: matchResult.closestFutureShiftEnd || new Date(matchResult.closestFutureShift.getTime() + (8 * 60 * 60 * 1000)),
          date: getStartOfDayIST(matchResult.closestFutureShift)
        };
        targetDate = matchedShift.date;
      } else {
        targetDate = getStartOfDayIST(now);
      }
    }

    // ── Check for Week Offs and Holidays ──
    const targetIST = getISTDateComponents(targetDate);
    const dayName = targetIST.dayName;
    const holiday = await Holiday.findOne({ companyId: req.tenant.companyId, holiday_date: targetDate });

    if (holiday) {
      return res.status(400).json({ success: false, message: `Today is ${holiday.holiday_name} (Holiday). Attendance is not required.` });
    }

    let existingAttendance = await Attendance.findOne({
      companyId: req.tenant.companyId,
      user: userId,
      date: targetDate
    });

    if (existingAttendance) {
      if (existingAttendance.status !== 'Absent' && !existingAttendance.punchOut?.time) {
        return res.status(400).json({ success: false, message: 'You already have an active session. Please punch out first.' });
      }
      if (existingAttendance.status !== 'Absent' && existingAttendance.punchOut?.time) {
        return res.status(400).json({ success: false, message: 'You have already completed your attendance for today.' });
      }
    }

    const livenessEvaluation = await evaluatePunchLiveness({
      userId,
      purpose: 'punchIn',
      liveness,
      selfie,
    });
    if (!livenessEvaluation.accepted) {
      return res.status(403).json({
        success: false,
        code: livenessEvaluation.code,
        message: livenessEvaluation.message,
      });
    }

    // Auto-close prior-day sessions only after liveness accepts this punch attempt.
    try {
      const autoPunchOutService = require('../services/autoPunchOutService');
      await autoPunchOutService.closePriorDayAttendances(userId, req.tenant?.companyId);
    } catch (e) {
      console.error('Auto-closure check in punchIn failed:', e.message);
    }

    if (existingAttendance?.status === 'Absent') {
      await Attendance.deleteOne({ _id: existingAttendance._id });
      existingAttendance = null;
    }

    // Multi-location geofence evaluation:
    // Check assigned workingPlace first, or ANY valid active company working place
    let matchedOffice = user?.workingPlace || officeMain;
    let minDistance = matchedOffice ? calculateDistance(latitude, longitude, matchedOffice.latitude, matchedOffice.longitude) : Infinity;
    let isInsideAnyLocation = matchedOffice && minDistance <= (matchedOffice.radius || 200);

    if (!isInsideAnyLocation && allLocations && allLocations.length > 0) {
      for (const loc of allLocations) {
        const d = calculateDistance(latitude, longitude, loc.latitude, loc.longitude);
        if (d <= (loc.radius || 200)) {
          isInsideAnyLocation = true;
          matchedOffice = loc;
          minDistance = d;
          break;
        } else if (d < minDistance) {
          minDistance = d;
          matchedOffice = loc;
        }
      }
    }

    const isManagementExempt = rbac.isManagementNoAttendanceRestriction(user);
    const isOutside = isManagementExempt ? false : !isInsideAnyLocation;

    let isLate = false;
    let lateTime = 0;
    let isHalfDay = false;
    let status = 'Present';

    // Check if user has an approved half-day leave for targetDate
    const Leave = require('../models/Leave');
    const targetDayStart = getStartOfDayIST(new Date(targetDate));
    const targetDayEnd = getEndOfDayIST(new Date(targetDate));
    const halfDayLeave = await Leave.findOne({
      companyId: req.tenant.companyId,
      user: userId,
      status: 'Approved',
      duration: 'Half Day',
      startDate: { $lte: targetDayEnd },
      endDate: { $gte: targetDayStart }
    }).lean();

    let halfDaySession = null;
    if (halfDayLeave) {
      halfDaySession = halfDayLeave.session || (halfDayLeave.startTime && halfDayLeave.startTime >= '13:00' ? 'Session 2' : 'Session 1');
    }

    const tempAttendance = {
      date: targetDate,
      punchIn: { time: now },
      status: 'Present',
      shiftInfo: user.shift,
      halfDaySession
    };

    status = statsService.resolveStatus(tempAttendance, user);
    isHalfDay = status === 'Half Day';
    isLate = status === 'Late';
    lateTime = isLate ? statsService.calculateLateTime({ date: targetDate, punchIn: { time: now }, halfDaySession }, user.shift) : 0;

    // Outstation Evaluation: >= 150 km (150,000 meters) from assigned workingPlace
    const assignedWorkplace = user?.workingPlace || officeMain;
    const outstationDistMeters = (assignedWorkplace && assignedWorkplace.latitude != null && assignedWorkplace.longitude != null)
      ? await resolveOutstationDistanceMeters(latitude, longitude, assignedWorkplace.latitude, assignedWorkplace.longitude)
      : minDistance;
    const isOutstation = outstationDistMeters >= 150000;
    const outstationDistanceKm = isOutstation ? Math.round(outstationDistMeters / 1000) : 0;
    const outstationDetectedAt = isOutstation ? now : null;

    const attendance = await Attendance.create({
      companyId: req.tenant.companyId,
      user: userId,
      date: targetDate,
      punchIn: {
        time: now,
        location: { latitude, longitude, address },
        selfie: (selfie && typeof selfie === 'string' && selfie.startsWith('http')) ? selfie : null,
        ...(livenessEvaluation.record ? { liveness: livenessEvaluation.record } : {}),
        isOutside: isOutside
      },
      status,
      isLate,
      lateTime,
      isHalfDay,
      halfDaySession,
      isOutside,
      isOutstation,
      wasOutstation: isOutstation,
      outstationDistanceKm,
      outstationDetectedAt,
      shiftInfo: user.shift ? {
        name: user.shift.name,
        startTime: user.shift.startTime,
        endTime: user.shift.endTime,
        requiredHours: user.shift.workingHours,
        gracePeriod: user.shift.gracePeriod,
        halfDayAfter: user.shift.halfDayAfter,
        firstSession: user.shift.firstSession,
        secondSession: user.shift.secondSession
      } : undefined
    });

    const resData = attendance.toObject();
    if (resData.punchIn?.selfie && resData.punchIn.selfie.startsWith('data:')) {
      resData.punchIn.selfie = 'uploading';
    }

    res.status(201).json({
      success: true,
      message: 'Punched in successfully',
      data: resData,
    });

    // Asynchronous Cloudinary upload in background (zero delay for client)
    if (selfie && selfie !== 'skipped' && selfie !== 'pending_background_upload' && !selfie.startsWith('http') && !selfie.startsWith('file://') && !selfie.startsWith('content://')) {
      setImmediate(async () => {
        try {
          const selfieData = await uploadToCloudinary(selfie, 'hrms/attendance/selfies');
          if (selfieData?.url) {
            await Attendance.updateOne(
              { _id: attendance._id },
              { $set: { 'punchIn.selfie': selfieData.url } }
            );
            console.log(`[Attendance] Background punch-in selfie uploaded for user ${userId}:`, selfieData.url);
          }
        } catch (uploadErr) {
          console.error('[Attendance] Background punch-in selfie upload error:', uploadErr.message);
        }
      });
    }

    // Hook in automated notifications
    try {
      const autoNotif = require('../services/autoNotificationService');
      const io = req.app.get('io');
      if (attendance.isLate || attendance.status === 'Late') {
        autoNotif.triggerLateArrival(userId, attendance.lateTime, io);
      }
      // Socket.IO Outstation Alert Broadcast (0 DB calls)
      if (io) {
        const outAlert = {
          userId: user._id,
          name: user.name,
          isOutstation,
          distanceKm: outstationDistanceKm,
          timestamp: now
        };
        if (req.tenant?.companyId) {
          io.to(`company:${req.tenant.companyId}`).emit('employeeOutstationAlert', outAlert);
          io.to(`company:${req.tenant.companyId}:admin`).emit('employeeOutstationAlert', outAlert);
        }
        if (typeof io.emit === 'function') {
          io.emit('employeeOutstationAlert', outAlert);
        }
      }

      // Sync LiveStatus Outstation state in DB AND in RAM Cache (so flush never overwrites it)
      try {
        const { LiveEmployeeStatus } = require('../models/Tracking');
        if (LiveEmployeeStatus && req.tenant?.companyId) {
          LiveEmployeeStatus.findOneAndUpdate(
            { companyId: req.tenant.companyId, userId: user._id },
            {
              $set: {
                isOutstation,
                outstationDistanceKm,
                isOutside,
                lastLocation: { type: 'Point', coordinates: [Number(longitude), Number(latitude)] },
                lastRawLocation: { type: 'Point', coordinates: [Number(longitude), Number(latitude)] },
                lastAddress: address || matchedOffice?.name || null,
                lastUpdate: now,
                movementState: isOutside ? 'Idle' : 'Inside Office'
              }
            }
          ).catch(() => { });
        }
        const trackingCache = require('../services/trackingCache');
        if (trackingCache?.liveStatus && req.tenant?.companyId) {
          trackingCache.liveStatus.update(user._id.toString(), req.tenant.companyId.toString(), {
            isOutstation,
            outstationDistanceKm,
            isOutside,
            lastLocation: { type: 'Point', coordinates: [Number(longitude), Number(latitude)] },
            lastRawLocation: { type: 'Point', coordinates: [Number(longitude), Number(latitude)] },
            lastAddress: address || matchedOffice?.name || null,
            lastUpdate: now,
            movementState: isOutside ? 'Idle' : 'Inside Office',
          }).catch(() => { });
          if (false) trackingCache.liveStatus.update(user._id.toString(), req.tenant.companyId.toString(), {
            isOutstation,
            outstationDistanceKm
          }).catch(() => { });
        }
      } catch (_) { }
    } catch (e) {
      console.error('Punch in notification hook failed:', e);
    }
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

exports.punchOut = async (req, res, next) => {
  try {
    const { latitude, longitude, address, selfie, liveness } = req.body;
    const userId = req.user.id;

    // Parallelize DB lookups (Selfie upload moved to background)
    const [attendance, officeMain, user, allLocations] = await Promise.all([
      Attendance.findOne({
        companyId: req.tenant.companyId,
        user: userId,
        "punchOut.time": { $exists: false }
      }).sort('-date'),
      Location.findOne({ companyId: req.tenant.companyId, name: 'Office Main' }).then(loc => loc || Location.findOne({ companyId: req.tenant.companyId })),
      User.findById(userId).populate('shift').populate('workingPlace'),
      Location.find({ companyId: req.tenant.companyId })
    ]);

    if (!attendance) {
      return res.status(400).json({ success: false, message: 'No active punch-in session found' });
    }

    let matchedOffice = user?.workingPlace || officeMain;
    let minDistance = matchedOffice ? calculateDistance(latitude, longitude, matchedOffice.latitude, matchedOffice.longitude) : Infinity;
    let isInsideAnyLocation = matchedOffice && minDistance <= (matchedOffice.radius || 200);

    if (!isInsideAnyLocation && allLocations && allLocations.length > 0) {
      for (const loc of allLocations) {
        const d = calculateDistance(latitude, longitude, loc.latitude, loc.longitude);
        if (d <= (loc.radius || 200)) {
          isInsideAnyLocation = true;
          matchedOffice = loc;
          minDistance = d;
          break;
        } else if (d < minDistance) {
          minDistance = d;
          matchedOffice = loc;
        }
      }
    }

    const outOutside = !isInsideAnyLocation;

    attendance.punchOut = {
      time: new Date(),
      location: { latitude, longitude, address },
      selfie: (selfie && typeof selfie === 'string' && selfie.startsWith('http')) ? selfie : null,
      isOutside: outOutside
    };

    attendance.isOutside = attendance.isOutside || outOutside;

    if (!attendance.halfDaySession) {
      const Leave = require('../models/Leave');
      const recDate = attendance.date || new Date();
      const targetDayStart = getStartOfDayIST(new Date(recDate));
      const targetDayEnd = getEndOfDayIST(new Date(recDate));
      const halfDayLeave = await Leave.findOne({
        companyId: req.tenant.companyId,
        user: userId,
        status: 'Approved',
        duration: 'Half Day',
        startDate: { $lte: targetDayEnd },
        endDate: { $gte: targetDayStart }
      }).lean();
      if (halfDayLeave) {
        attendance.halfDaySession = halfDayLeave.session || (halfDayLeave.startTime && halfDayLeave.startTime >= '13:00' ? 'Session 2' : 'Session 1');
      }
    }

    // Recalculate status with 90% Rule upon Punch Out
    const finalStatus = statsService.resolveStatus(attendance, user);
    attendance.status = finalStatus;
    attendance.isHalfDay = finalStatus === 'Half Day';
    attendance.isLate = finalStatus === 'Late';

    const livenessEvaluation = await evaluatePunchLiveness({
      userId,
      purpose: 'punchOut',
      liveness,
      selfie,
    });
    if (!livenessEvaluation.accepted) {
      return res.status(403).json({
        success: false,
        code: livenessEvaluation.code,
        message: livenessEvaluation.message,
      });
    }

    // Sort and deduplicate raw tracking points on punch out for accurate distance
    const rawPoints = await RawTrackingPoint.find({
      companyId: req.tenant.companyId,
      userId,
      sessionId: attendance._id
    }).sort('timestamp').lean();

    // Calculate Net Working Hours and Distance using Centralized Services
    attendance.workingHours = statsService.calculateWorkingHours(attendance, user);
    attendance.distance = geoService.calculateTotalDistance(rawPoints.map(p => ({
      latitude: p.rawLatitude || p.location.coordinates[1],
      longitude: p.rawLongitude || p.location.coordinates[0]
    })));
    attendance.totalDistance = attendance.distance;
    attendance.currentDistance = attendance.distance;

    const assignedWorkplaceOut = user?.workingPlace || officeMain;
    const outstationDistMetersOut = (assignedWorkplaceOut && assignedWorkplaceOut.latitude != null && assignedWorkplaceOut.longitude != null)
      ? await resolveOutstationDistanceMeters(latitude, longitude, assignedWorkplaceOut.latitude, assignedWorkplaceOut.longitude)
      : minDistance;
    if (outstationDistMetersOut < 150000 && attendance.isOutstation) {
      attendance.isOutstation = false;
      attendance.outstationDistanceKm = 0;
      attendance.outstationReturnedAt = new Date();
    }

    if (livenessEvaluation.record) {
      attendance.punchOut.liveness = livenessEvaluation.record;
    }

    await attendance.save();

    if (outstationDistMetersOut < 150000) {
      try {
        const { LiveEmployeeStatus } = require('../models/Tracking');
        if (LiveEmployeeStatus && req.tenant?.companyId) {
          LiveEmployeeStatus.findOneAndUpdate(
            { companyId: req.tenant.companyId, userId },
            { $set: { isOutstation: false, outstationDistanceKm: 0 } }
          ).catch(() => { });
        }
        const trackingCache = require('../services/trackingCache');
        if (trackingCache?.liveStatus && req.tenant?.companyId) {
          trackingCache.liveStatus.update(userId.toString(), req.tenant.companyId.toString(), {
            isOutstation: false,
            outstationDistanceKm: 0
          }).catch(() => { });
        }
        const io = req.app.get('io');
        if (io) {
          const clearAlert = {
            userId,
            name: user.name,
            isOutstation: false,
            distanceKm: 0,
            timestamp: new Date()
          };
          if (req.tenant?.companyId) {
            io.to(`company:${req.tenant.companyId}`).emit('employeeOutstationAlert', clearAlert);
            io.to(`company:${req.tenant.companyId}:admin`).emit('employeeOutstationAlert', clearAlert);
          }
          if (typeof io.emit === 'function') {
            io.emit('employeeOutstationAlert', clearAlert);
          }
        }
      } catch (_) { }
    }

    try {
      const trackingCache = require('../services/trackingCache');
      trackingCache.invalidateAttendance(userId);
    } catch (_) { }

    const resData = attendance.toObject();
    if (resData.punchIn?.selfie && resData.punchIn.selfie.startsWith('data:')) {
      resData.punchIn.selfie = 'uploading';
    }
    if (resData.punchOut?.selfie && resData.punchOut.selfie.startsWith('data:')) {
      resData.punchOut.selfie = 'uploading';
    }

    res.status(200).json({
      success: true,
      message: 'Punched out successfully',
      data: resData,
    });

    // Asynchronous Cloudinary upload in background for punchOut (zero delay for client)
    if (selfie && selfie !== 'skipped' && selfie !== 'pending_background_upload' && !selfie.startsWith('http') && !selfie.startsWith('file://') && !selfie.startsWith('content://')) {
      setImmediate(async () => {
        try {
          const selfieData = await uploadToCloudinary(selfie, 'hrms/attendance/selfies');
          if (selfieData?.url) {
            await Attendance.updateOne(
              { _id: attendance._id },
              { $set: { 'punchOut.selfie': selfieData.url } }
            );
            console.log(`[Attendance] Background punch-out selfie uploaded for user ${userId}:`, selfieData.url);
          }
        } catch (uploadErr) {
          console.error('[Attendance] Background punch-out selfie upload error:', uploadErr.message);
        }
      });
    }

    // Notify mobile app via socket to stop background tracking and release WakeLock
    try {
      const io = req.app.get('io');
      if (io && userId) {
        io.to(userId.toString()).emit('attendance:punched_out', {
          attendanceId: attendance._id,
          punchOutTime: attendance.punchOut?.time,
        });
      }
    } catch (_) { }

    // Hook in automated notifications (Punch-Out notification is now scheduled automatically after shift instead of instant)
    /* try {
      const autoNotif = require('../services/autoNotificationService');
      const io = req.app.get('io');
      const timeStr = new Date(attendance.punchOut.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      autoNotif.triggerPunchOut(userId, timeStr, io);
    } catch (e) {
      console.error('Punch out notification hook failed:', e);
    } */
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

// @desc    Get attendance history
// @route   GET /api/attendance/history
// @access  Private
exports.getHistory = async (req, res, next) => {
  try {
    const { startDate, endDate } = req.query;
    const query = {
      companyId: req.tenant.companyId,
      user: req.user.id,
      "punchIn.time": { $exists: true }
    };

    if (startDate || endDate) {
      query.date = {};
      if (startDate) {
        const [sY, sM, sD] = startDate.split('-').map(Number);
        query.date.$gte = createDateFromIST(sY, sM - 1, sD, 0, 0, 0, 0);
      }
      if (endDate) {
        const [eY, eM, eD] = endDate.split('-').map(Number);
        query.date.$lte = createDateFromIST(eY, eM - 1, eD, 23, 59, 59, 999);
      }
    }

    const attendanceRaw = await Attendance.find(query).populate({
      path: 'user',
      populate: { path: 'shift' }
    }).sort('-date');

    const attendance = attendanceRaw.map(a => {
      const record = a.toObject();
      return {
        ...record,
        workingHours: statsService.calculateWorkingHours(record, record.user),
        status: statsService.resolveStatus(record, record.user)
      };
    });

    res.status(200).json({
      success: true,
      count: attendance.length,
      data: attendance,
    });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

// @desc    Get all attendance for Admin
// @route   GET /api/attendance
// @access  Private/Admin
exports.getAllAttendance = async (req, res, next) => {
  try {
    const { date } = req.query;
    let query = { companyId: req.tenant.companyId };
    let searchDate = new Date();
    let start, end;

    if (date) {
      const [year, month, day] = date.split('-').map(Number);
      start = createDateFromIST(year, month - 1, day, 0, 0, 0, 0);
      end = createDateFromIST(year, month - 1, day, 23, 59, 59, 999);

      query.date = { $gte: start, $lte: end };
      searchDate = start;
    } else {
      const now = new Date();
      start = getStartOfDayIST(now);
      end = getEndOfDayIST(now);

      query.date = { $gte: start, $lte: end };
      searchDate = start;
    }

    const attendanceRaw = await Attendance.find(query)
      .populate({
        path: 'user',
        select: 'name email mobile department designation profileImage shift createdAt joiningDate role roleCode departmentAdminType adminType',
        populate: { path: 'shift' }
      })
      .sort('-date');

    // Deduplicate attendance records by user._id + date string to prevent duplicate punches showing for the same day
    const seenMap = new Map();
    const attendance = [];
    for (const a of attendanceRaw) {
      const record = a.toObject();
      if (!record.user) continue;
      // Do not show company admin users (accounts admin, hr admin, store admin, company admin, etc.)
      if (isCompanyAdminUser(record.user)) continue;
      const userIdStr = record.user?._id?.toString() || record.user?.toString() || 'unknown';
      const dateKey = `${userIdStr}_${new Date(record.date).toISOString().split('T')[0]}`;
      if (!seenMap.has(dateKey)) {
        seenMap.set(dateKey, true);
        attendance.push({
          ...record,
          workingHours: statsService.calculateWorkingHours(record, record.user),
          status: statsService.resolveStatus(record, record.user)
        });
      }
    }

    const Holiday = require('../models/Holiday');
    const targetIST = getISTDateComponents(searchDate);
    const searchDateStart = new Date(Date.UTC(targetIST.year, targetIST.month, targetIST.date, 0, 0, 0, 0));
    const searchDateEnd = new Date(Date.UTC(targetIST.year, targetIST.month, targetIST.date, 23, 59, 59, 999));

    const [isHoliday, approvedLeaves, settings, mobileConfig] = await Promise.all([
      Holiday.findOne({ companyId: req.tenant.companyId, holiday_date: { $gte: searchDateStart, $lte: searchDateEnd }, status: 'active' }),
      Leave.find({
        companyId: req.tenant.companyId,
        status: 'Approved',
        startDate: { $lte: searchDateEnd },
        endDate: { $gte: searchDateStart }
      }),
      CompanySetting.findOne({ companyId: req.tenant.companyId }),
      MobileAppConfig.findOne({ companyId: req.tenant.companyId })
    ]);

    const leaveUserIdsSet = new Set(approvedLeaves.map(l => l.user.toString()));
    const allUsers = await User.find({
      companyId: req.tenant.companyId,
      status: { $in: ['ACTIVE', 'active'] },
      role: { $nin: COMPANY_ADMIN_ROLES },
      roleCode: { $nin: COMPANY_ADMIN_ROLE_CODES }
    }).populate('shift', 'name startTime endTime').populate('levelRef');
    const presentUserIds = new Set(attendance.map(a => a.user?._id?.toString()));

    const now = new Date();

    const absentRecords = allUsers
      .filter(user => isUserActive(user))
      .filter(user => !isCompanyAdminUser(user))
      .filter(user => !presentUserIds.has(user._id.toString()))
      .filter(user => {
        // If attendance is blocked/disabled for this employee, don't generate synthetic absent record
        if (isUserAttendanceBlocked(user, mobileConfig, user.levelRef)) return false;

        const userCreated = new Date(user.createdAt || user.joiningDate || Date.now());
        userCreated.setUTCHours(0, 0, 0, 0);

        // If user created AFTER the search date, they don't exist yet
        if (userCreated > searchDateStart) return false;

        return true;
      })
      .map(user => {
        const userCreated = new Date(user.createdAt);
        userCreated.setUTCHours(0, 0, 0, 0);

        const weeklyOffs = settings?.weeklyOffs || ['Sunday'];
        const dayName = getISTDateComponents(searchDate).dayName;

        let status = 'Absent';
        if (leaveUserIdsSet.has(user._id.toString())) {
          status = 'On Leave';
        } else if (weeklyOffs.includes(dayName) || isHoliday) {
          status = 'Not Punched In';
        } else {
          if (userCreated.getTime() === searchDateStart.getTime()) {
            status = 'Not Punched In';
          } else {
            // Check if shift is ended
            let isShiftEnded = false;
            if (searchDateEnd < now) {
              isShiftEnded = true;
            } else {
              if (user.shift && typeof user.shift === 'object' && user.shift.startTime && user.shift.endTime) {
                const [eH, eM] = String(user.shift.endTime).split(':').map(Number);
                const [sH, sM] = String(user.shift.startTime).split(':').map(Number);
                if (!isNaN(eH) && !isNaN(eM) && !isNaN(sH) && !isNaN(sM)) {
                  const searchIST = getISTDateComponents(searchDate);
                  let shiftEnd = createDateFromIST(searchIST.year, searchIST.month, searchIST.date, eH, eM);
                  if (eH < sH || (eH === sH && eM < sM)) {
                    shiftEnd = createDateFromIST(searchIST.year, searchIST.month, searchIST.date + 1, eH, eM);
                  }
                  if (now >= shiftEnd) {
                    isShiftEnded = true;
                  }
                } else {
                  const nowIST = getISTDateComponents(now);
                  if (nowIST.hour >= 23) {
                    isShiftEnded = true;
                  }
                }
              } else {
                const nowIST = getISTDateComponents(now);
                if (nowIST.hour >= 23) {
                  isShiftEnded = true;
                }
              }
            }

            if (isShiftEnded) {
              status = 'Absent';
            } else {
              status = 'Not Punched In';
            }
          }
        }

        return {
          _id: `absent_${user._id}`,
          user: user,
          date: searchDate,
          status: status,
          punchIn: null,
          punchOut: null,
          isLate: false,
          isHalfDay: false,
          isOutside: false,
          workingHours: 0,
          totalDistance: 0
        };
      });

    const finalData = [...attendance, ...absentRecords];

    res.status(200).json({
      success: true,
      count: finalData.length,
      data: finalData,
    });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

// @desc    Track Live Location
// @route   POST /api/attendance/track
// @access  Private
exports.trackLocation = async (req, res, next) => {
  try {
    const { latitude, longitude, accuracy, speed, altitude, heading, battery } = req.body;
    const userId = req.user.id;

    const now = new Date();
    const attendance = await Attendance.findOne({
      companyId: req.tenant.companyId,
      user: userId,
      'punchIn.time': { $exists: true, $ne: null },
      $or: [
        { 'punchOut.time': { $exists: false } },
        { 'punchOut.time': null }
      ]
    }).sort('-date');

    if (!attendance) {
      return res.status(404).json({ success: false, message: 'No active session found to track' });
    }

    // Guard: Check if tracking is disabled for this user by Super Admin configuration
    try {
      const MobileAppConfig = require('../models/MobileAppConfig');
      const Level = require('../models/Level');
      const { getEffectiveLevelNumber, getEffectiveCategory } = require('../middleware/rbac');

      const config = await MobileAppConfig.findOne({ companyId: req.tenant.companyId });
      if (config && config.trackingControl && req.user) {
        let userLevel = req.user.levelRef;
        if (!userLevel && req.user.roleLevel) {
          userLevel = await Level.findOne({ companyId: req.tenant.companyId, levelNumber: req.user.roleLevel });
        }

        let userLevelNumber = null;
        if (userLevel?.levelNumber != null) {
          userLevelNumber = Number(userLevel.levelNumber);
        } else if (req.user.roleLevel != null && req.user.roleLevel >= 1) {
          userLevelNumber = Number(req.user.roleLevel);
        } else {
          const lvl = getEffectiveLevelNumber(req.user);
          if (lvl && lvl !== 99) userLevelNumber = Number(lvl);
        }

        if (config.trackingControl.blockedLevels && config.trackingControl.blockedLevels.length > 0 && userLevelNumber != null) {
          if (config.trackingControl.blockedLevels.map(Number).includes(userLevelNumber)) {
            return res.status(200).json({ success: true, message: 'Tracking disabled for user level', trackingDisabled: true });
          }
        }

        const userCat = userLevel?.category || getEffectiveCategory(req.user) || req.user.effectiveCategory;
        if (config.trackingControl.blockedCategories && config.trackingControl.blockedCategories.length > 0 && userCat) {
          if (config.trackingControl.blockedCategories.map(c => String(c).toUpperCase()).includes(String(userCat).toUpperCase())) {
            return res.status(200).json({ success: true, message: 'Tracking disabled for user category', trackingDisabled: true });
          }
        }
      }
    } catch (_) { }

    const user = await User.findById(userId).populate('workingPlace');
    const office = user?.workingPlace || (await Location.findOne({ companyId: req.tenant.companyId, name: 'Office Main' }) || await Location.findOne({ companyId: req.tenant.companyId }));

    // Last known point from the summary fields (embedded trackingLogs removed 2026-06-30)
    let lastPoint = null;
    if (attendance.lastTrackedLocation && attendance.lastTrackedLocation.latitude) {
      lastPoint = {
        latitude: attendance.lastTrackedLocation.latitude,
        longitude: attendance.lastTrackedLocation.longitude,
        time: attendance.lastTrackedLocation.time || attendance.lastTrackingTime
      };
    } else {
      const latestRaw = await RawTrackingPoint.findOne({
        companyId: req.tenant.companyId,
        userId,
        sessionId: attendance._id
      }).sort('-timestamp').lean();
      if (latestRaw) {
        lastPoint = {
          latitude: latestRaw.rawLatitude || latestRaw.location.coordinates[1],
          longitude: latestRaw.rawLongitude || latestRaw.location.coordinates[0],
          time: latestRaw.timestamp
        };
      } else {
        lastPoint = {
          latitude: attendance.punchIn.location.latitude,
          longitude: attendance.punchIn.location.longitude,
          time: attendance.punchIn.time
        };
      }
    }

    // Enterprise validation check
    const validation = geoService.validateLocation(lastPoint, {
      latitude,
      longitude,
      accuracy,
      time: now
    });

    // Geofence check using centralized geofenceService
    const geofenceService = require('../services/geofenceService');
    const geofenceList = await geofenceService.resolveUserGeofences(userId, req.tenant.companyId);
    const geofenceCheck = geofenceService.checkPointGeofence(latitude, longitude, geofenceList);
    const isOutside = !geofenceCheck.isInside;

    // Determine status of point
    let pointStatus = 'valid';
    let incrementalDistance = 0;

    if (validation.isRecovery) {
      pointStatus = 'valid';
      // Recovery starts fresh segment, incrementalDistance is 0
    } else if (validation.isWeak) {
      pointStatus = 'weak';
    } else if (validation.isSuspicious) {
      pointStatus = 'suspicious';
    } else if (validation.status === 'idle' || (!validation.isValid && !validation.isSuspicious)) {
      pointStatus = 'idle';
    } else {
      incrementalDistance = validation.distance;
    }

    const previousOutside = attendance.isOutside;

    // Atomic summary update — no full-document rewrite, no embedded array (mirrors enterpriseTrackingService)
    const summaryUpdate = {
      $set: {
        isOutside,
        lastTrackedLocation: { latitude, longitude, time: now, address: null },
        lastTrackingTime: now,
        signalStatus: 'online'
      },
      $inc: { trackingPointCount: 1 }
    };
    if (battery) summaryUpdate.$set.battery = battery;

    // Incremental distance — only valid points >= 5m count, and only when OUTSIDE geofence
    if (isOutside && pointStatus === 'valid' && incrementalDistance >= 0.005) {
      summaryUpdate.$inc.totalDistance = parseFloat(incrementalDistance.toFixed(6));
      summaryUpdate.$inc.currentDistance = parseFloat(incrementalDistance.toFixed(6));
      summaryUpdate.$inc.distance = parseFloat(incrementalDistance.toFixed(6));
    }

    if (!attendance.firstTrackedLocation || !attendance.firstTrackedLocation.latitude) {
      summaryUpdate.$set.firstTrackedLocation = { latitude, longitude, time: now, address: null };
    }

    await Attendance.updateOne({ _id: attendance._id }, summaryUpdate);

    // Keep the in-memory doc in sync for downstream socket/response code
    attendance.isOutside = isOutside;
    attendance.lastTrackedLocation = { latitude, longitude, time: now, address: null };
    attendance.lastTrackingTime = now;
    attendance.trackingPointCount = (attendance.trackingPointCount || 0) + 1;
    attendance.totalDistance = (attendance.totalDistance || 0) + (isOutside && pointStatus === 'valid' && incrementalDistance >= 0.005 ? incrementalDistance : 0);
    attendance.distance = attendance.totalDistance;
    attendance.currentDistance = attendance.totalDistance;
    if (battery) attendance.battery = battery;

    // Also write to RawTrackingPoint (Enterprise tracking history) — dedupe by timestamp
    const existingRaw = await RawTrackingPoint.findOne({
      companyId: req.tenant.companyId,
      userId,
      sessionId: attendance._id,
      timestamp: now
    });
    const rawPoint = existingRaw || await RawTrackingPoint.create({
      companyId: req.tenant.companyId,
      userId,
      sessionId: attendance._id,
      tripId: attendance._id.toString(),
      deviceId: req.body.deviceId || 'unknown',
      location: { type: 'Point', coordinates: [longitude, latitude] },
      rawLatitude: latitude,
      rawLongitude: longitude,
      accuracy,
      speed,
      heading,
      altitude,
      battery,
      timestamp: now,
      status: pointStatus,
      isMock: req.body.isMocked
    });

    // Update Live Status
    let liveStatus = await LiveEmployeeStatus.findOne({ companyId: req.tenant.companyId, userId });
    if (!liveStatus) {
      liveStatus = new LiveEmployeeStatus({ companyId: req.tenant.companyId, userId });
    }

    liveStatus.lastLocation = rawPoint.location;
    liveStatus.currentSpeed = speed || 0;
    liveStatus.lastUpdate = now;
    liveStatus.totalDistanceToday = attendance.totalDistance;

    // Detect movement state based on speed
    const speedMs = speed || 0;
    const speedKmh = speedMs * 3.6;
    let moveState = 'Idle';
    if (speedKmh < 1) moveState = 'Idle';
    else if (speedKmh < 6) moveState = 'Walking';
    else if (speedKmh < 25) moveState = 'Bike';
    else if (speedKmh < 100) moveState = 'Vehicle';
    else moveState = 'Suspicious';

    liveStatus.movementState = moveState;
    liveStatus.currentStatus = 'online';
    if (battery) liveStatus.batteryLevel = battery;

    // Background Geocoding Check
    const currentCoords = rawPoint.location.coordinates;
    let shouldGeocode = false;

    if (!liveStatus.lastAddress) {
      shouldGeocode = true;
    } else {
      const lastGeocodedCoords = liveStatus.lastGeocodedLocation?.coordinates || liveStatus.lastLocation?.coordinates;
      if (lastGeocodedCoords) {
        const distSinceLastGeocode = geoService.calculateDistance(
          lastGeocodedCoords[1], lastGeocodedCoords[0],
          currentCoords[1], currentCoords[0]
        );
        const timeSinceLastGeocode = liveStatus.lastGeocodeTime ? (Date.now() - new Date(liveStatus.lastGeocodeTime).getTime()) / 1000 : Infinity;

        if (distSinceLastGeocode > 0.1 || timeSinceLastGeocode > 300) {
          shouldGeocode = true;
        }
      } else {
        shouldGeocode = true;
      }
    }

    if (shouldGeocode) {
      reverseGeocodeAsync(userId, rawPoint).catch(err => {
        console.error('[EnterpriseTracking] Background geocode from trackLocation failed:', err);
      });
    }

    await liveStatus.save();

    // Hook in automated notifications for geofence exit/entry
    try {
      const autoNotif = require('../services/autoNotificationService');
      const io = req.app.get('io');
      if (isOutside && !previousOutside) {
        autoNotif.triggerOutsideGeofence(userId, geofenceCheck?.matchedLocation?.name || office?.name || 'Office Main', io);
      } else if (!isOutside && previousOutside) {
        autoNotif.triggerGeofenceEntry(userId, geofenceCheck?.matchedLocation?.name || office?.name || 'Office Main', io);
      }
    } catch (e) {
      console.error('Geofence tracking notification hook failed:', e);
    }

    const io = req.app.get('io');
    if (io) {
      io.to(`company:${req.tenant.companyId}:tracking`).emit('locationUpdated', {
        companyId: req.tenant.companyId,
        userId,
        userName: req.user.name,
        latitude,
        longitude,
        address: liveStatus.lastAddress || 'Live Tracking...',
        time: now,
        totalDistance: attendance.totalDistance,
        isOutside
      });
    }

    res.status(200).json({ success: true, message: 'Location tracked', isOutside, totalDistance: attendance.totalDistance });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

// @desc    Get monthly attendance view
exports.getMonthlyView = async (req, res, next) => {
  try {
    const { month, year } = req.query;
    const userId = req.user.id;

    if (!month || !year) {
      return res.status(400).json({ success: false, message: 'Please provide month and year' });
    }

    const user = await User.findById(userId).select('+createdAt');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const joiningDate = user.createdAt ? getStartOfDayIST(new Date(user.createdAt)) : new Date(0);

    const startDate = createDateFromIST(parseInt(year), parseInt(month) - 1, 1, 0, 0, 0, 0);
    const endDate = createDateFromIST(parseInt(year), parseInt(month), 1, 0, 0, 0, 0);

    const attendance = await Attendance.find({
      companyId: req.tenant.companyId,
      user: userId,
      date: { $gte: startDate, $lt: endDate }
    }).sort('date');

    const summary = { present: 0, late: 0, halfDay: 0, absent: 0, onLeave: 0, totalWorkedHours: 0, totalBreakMinutes: 0 };


    const leaves = await Leave.find({
      companyId: req.tenant.companyId,
      user: userId,
      status: 'Approved',
      $or: [
        { startDate: { $gte: startDate, $lt: endDate } },
        { endDate: { $gte: startDate, $lt: endDate } }
      ]
    });

    const daysInMonth = new Date(year, month, 0).getDate();
    const dailyStatus = {};
    const now = new Date();

    const [settings, monthHolidays] = await Promise.all([
      CompanySetting.findOne({ companyId: req.tenant.companyId }),
      Holiday.find({
        companyId: req.tenant.companyId,
        holiday_date: {
          $gte: startDate.toISOString().split('T')[0],
          $lt: endDate.toISOString().split('T')[0]
        }
      })
    ]);

    const holidayMap = {};
    monthHolidays.forEach(h => {
      const d = new Date(h.holiday_date).getUTCDate();
      holidayMap[d] = h.holiday_name;
    });

    for (let i = 1; i <= daysInMonth; i++) {
      const d = new Date(Date.UTC(year, month - 1, i));
      const dayName = d.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
      const isWeekOff = settings?.weeklyOffs?.includes(dayName);
      const holidayName = holidayMap[i];

      const nowIST = getISTDateComponents(now);
      const isFuture = (parseInt(year) > nowIST.year) ||
        (parseInt(year) === nowIST.year && parseInt(month) > (nowIST.month + 1)) ||
        (parseInt(year) === nowIST.year && parseInt(month) === (nowIST.month + 1) && i > nowIST.date);

      const isToday = (parseInt(year) === nowIST.year && parseInt(month) === (nowIST.month + 1) && i === nowIST.date);
      const isBeforeJoining = d.getTime() < joiningDate.getTime();

      let status = 'Absent';
      if (isFuture) status = 'Future';
      else if (isToday) status = 'Today';
      else if (isBeforeJoining) status = 'BeforeJoining';
      else if (holidayName) status = 'Holiday';
      else if (isWeekOff) status = 'Week Off';

      let color = (isWeekOff || holidayName || isFuture || isBeforeJoining || isToday) ? 'transparent' : '#f43f5e';
      if (holidayName) color = '#8b5cf6'; // Violet for holidays
      if (isWeekOff) color = '#94a3b8'; // Slate for week offs

      dailyStatus[i] = { status, color, isWeekOff, isHoliday: !!holidayName, holidayName, isFuture, isToday, isBeforeJoining };
    }

    leaves.forEach(leave => {
      let start = new Date(leave.startDate);
      let end = new Date(leave.endDate);
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        if (d.getUTCMonth() + 1 === parseInt(month) && d.getUTCFullYear() === parseInt(year)) {
          const day = d.getUTCDate();
          if (dailyStatus[day] && !dailyStatus[day].isBeforeJoining) {
            dailyStatus[day] = { ...dailyStatus[day], status: 'On Leave', color: '#f59e0b', isFuture: false };
            summary.onLeave++;
          }
        }
      }
    });

    attendance.forEach(record => {
      const day = getISTDateComponents(new Date(record.date)).date;
      const recordObj = record.toObject();
      let status = statsService.resolveStatus(recordObj, user);
      let color = '#10b981';
      if (status === 'Late' || status === 'Half Day') color = '#f59e0b';

      if (dailyStatus[day]) {
        dailyStatus[day] = {
          ...dailyStatus[day],
          status,
          color,
          isFuture: false,
          isBeforeJoining: false,
          punchIn: record.punchIn?.time,
          punchOut: record.punchOut?.time,
          punchInDetails: record.punchIn,
          punchOutDetails: record.punchOut,
          workingHours: record.workingHours,
          breaks: record.breaks
        };
        if (status === 'Present') summary.present++;
        else if (status === 'Late') summary.late++;
        else if (status === 'Half Day') summary.halfDay++;
        summary.totalWorkedHours += statsService.calculateWorkingHours(recordObj);
        summary.totalBreakMinutes += record.breaks?.reduce((acc, b) => acc + (b.duration || 0), 0) || 0;
      }
    });

    summary.absent = 0;
    for (let i = 1; i <= daysInMonth; i++) {
      const dayStatus = dailyStatus[i];
      if (dayStatus.status === 'Absent' && !dayStatus.isWeekOff && !dayStatus.isHoliday && !dayStatus.isBeforeJoining && !dayStatus.isFuture && !dayStatus.isToday) {
        summary.absent++;
      }
    }

    res.status(200).json({ success: true, data: { summary, dailyStatus, daysInMonth, monthName: new Date(year, month - 1).toLocaleString('default', { month: 'long' }) } });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

exports.toggleBreak = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const attendance = await Attendance.findOne({ companyId: req.tenant.companyId, user: userId, "punchOut.time": { $exists: false } }).sort('-date');
    if (!attendance) return res.status(400).json({ success: false, message: 'No active punch-in session found' });

    const activeBreakIndex = attendance.breaks.findIndex(b => !b.endTime);
    if (activeBreakIndex !== -1) {
      attendance.breaks[activeBreakIndex].endTime = new Date();
      const diff = attendance.breaks[activeBreakIndex].endTime - attendance.breaks[activeBreakIndex].startTime;
      attendance.breaks[activeBreakIndex].duration = Math.round(diff / (1000 * 60));
    } else {
      attendance.breaks.push({ startTime: new Date() });
    }
    await attendance.save();
    res.status(200).json({ success: true, message: activeBreakIndex !== -1 ? 'Break ended' : 'Break started', data: attendance });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

// @desc    Admin edit attendance record (punch-in time, punch-out time, status)
// @route   PUT /api/attendance/admin-edit/:attendanceId
// @access  Private/Admin
exports.adminEditAttendance = async (req, res) => {
  try {
    const { attendanceId } = req.params;
    const { punchInTime, punchOutTime, status, userId } = req.body;

    // Validate at least one field is being changed
    if (!punchInTime && !punchOutTime && !status) {
      return res.status(400).json({ success: false, message: 'No changes provided. Supply punchInTime, punchOutTime or status.' });
    }

    let attendance;
    const isSynthetic = attendanceId.startsWith('synthetic-');

    if (isSynthetic) {
      const dateStr = attendanceId.replace('synthetic-', '');
      const targetDate = new Date(dateStr + 'T00:00:00.000Z');
      const targetUserId = userId || req.user.id;

      attendance = await Attendance.findOne({ companyId: req.tenant.companyId, user: targetUserId, date: targetDate }).populate({
        path: 'user',
        populate: { path: 'shift' }
      });

      if (!attendance) {
        const User = require('../models/User');
        const user = await User.findById(targetUserId).populate('shift');
        if (!user) {
          return res.status(404).json({ success: false, message: 'User not found' });
        }

        attendance = new Attendance({
          companyId: req.tenant.companyId,
          user: user, // Keep it populated for resolveStatus and calculateWorkingHours calls
          date: targetDate,
          status: status || 'Present',
          shiftInfo: user.shift ? {
            name: user.shift.name,
            startTime: user.shift.startTime,
            endTime: user.shift.endTime,
            requiredHours: user.shift.workingHours,
            gracePeriod: user.shift.gracePeriod,
            halfDayAfter: user.shift.halfDayAfter
          } : undefined
        });
      }
    } else {
      const mongoose = require('mongoose');
      if (!mongoose.Types.ObjectId.isValid(attendanceId)) {
        return res.status(400).json({ success: false, message: 'Invalid attendance ID' });
      }

      attendance = await Attendance.findOne({ _id: attendanceId, companyId: req.tenant.companyId }).populate({
        path: 'user',
        populate: { path: 'shift' }
      });
    }

    if (!attendance) {
      return res.status(404).json({ success: false, message: 'Attendance record not found' });
    }

    // Strict business rule: Only one time (either Punch In or Punch Out) can be modified per request
    if (punchInTime !== undefined && punchOutTime !== undefined && punchInTime !== '' && punchOutTime !== '') {
      return res.status(400).json({ success: false, message: 'Only one time (either Punch In or Punch Out) can be changed at a time.' });
    }

    // --- Apply punch-in time change ---
    if (punchInTime) {
      // punchInTime arrives as "HH:mm" (24-hour) on the attendance date in IST
      const [h, m] = punchInTime.split(':').map(Number);
      if (isNaN(h) || isNaN(m) || h < 0 || h > 23 || m < 0 || m > 59) {
        return res.status(400).json({ success: false, message: 'Invalid punch-in time format. Use HH:mm (24-hour).' });
      }

      // Build a full IST datetime for that attendance date at HH:mm
      const attDate = new Date(attendance.date);
      const istComponents = getISTDateComponents(attDate);
      const newPunchIn = createDateFromIST(istComponents.year, istComponents.month, istComponents.date, h, m, 0, 0);

      if (!attendance.punchIn) attendance.punchIn = {};
      attendance.punchIn.time = newPunchIn;
      attendance.markModified('punchIn');
    } else if (punchInTime === '') {
      // Clear punch-in time if explicitly passed as empty string
      if (attendance.punchIn) {
        attendance.punchIn.time = undefined;
        attendance.markModified('punchIn');
      }
    }

    // --- Apply punch-out time change ---
    if (punchOutTime) {
      const [h, m] = punchOutTime.split(':').map(Number);
      if (isNaN(h) || isNaN(m) || h < 0 || h > 23 || m < 0 || m > 59) {
        return res.status(400).json({ success: false, message: 'Invalid punch-out time format. Use HH:mm (24-hour).' });
      }

      const attDate = new Date(attendance.date);
      const istComponents = getISTDateComponents(attDate);
      let newPunchOut = createDateFromIST(istComponents.year, istComponents.month, istComponents.date, h, m, 0, 0);

      // If punch-out appears to be before punch-in (night shift / next-day scenario), push to next day
      if (attendance.punchIn?.time && newPunchOut <= new Date(attendance.punchIn.time)) {
        newPunchOut = new Date(newPunchOut.getTime() + 24 * 60 * 60 * 1000);
      }

      if (!attendance.punchOut) attendance.punchOut = {};
      attendance.punchOut.time = newPunchOut;
      attendance.markModified('punchOut');
    } else if (punchOutTime === '') {
      // Clear punch-out time if explicitly passed as empty string
      if (attendance.punchOut) {
        attendance.punchOut.time = undefined;
        attendance.markModified('punchOut');
      }
    }

    // --- IMPORTANT: capture recordObj AFTER all time mutations so recalculations use new values ---
    const user = attendance.user;
    const recordObj = attendance.toObject();
    const ALL_STATUSES = ['Present', 'Late', 'Half Day', 'Absent', 'Leave', 'Leave(Half)', 'Holiday', 'Week Off', 'Neutral'];

    if (status && ALL_STATUSES.includes(status)) {
      // Admin explicitly overrides status — honour it directly
      attendance.status = status;
      attendance.isLate = status === 'Late';
      attendance.isHalfDay = status === 'Half Day' || status === 'Leave(Half)';
      attendance.isManualOverride = true;
    } else if (status === '' || status === null) {
      attendance.isManualOverride = false;
      if (attendance.punchIn?.time) {
        const resolvedStatus = statsService.resolveStatus({ ...recordObj, isManualOverride: false, status: undefined }, user);
        attendance.status = resolvedStatus;
        attendance.isLate = resolvedStatus === 'Late';
        attendance.isHalfDay = resolvedStatus === 'Half Day';
      }
    } else if (attendance.punchIn?.time && !attendance.isManualOverride) {
      // Auto-recalculate status from updated times using canonical service
      const resolvedStatus = statsService.resolveStatus(recordObj, user);
      attendance.status = resolvedStatus;
      attendance.isLate = resolvedStatus === 'Late';
      attendance.isHalfDay = resolvedStatus === 'Half Day';
    }

    // Recalculate working hours using canonical service (with updated punchIn/punchOut)
    attendance.workingHours = statsService.calculateWorkingHours(recordObj);

    // Update lateTime field
    if (attendance.isLate && statsService.calculateLateTime) {
      attendance.lateTime = statsService.calculateLateTime(recordObj, user?.shift);
    } else {
      attendance.lateTime = 0;
    }

    await attendance.save();

    // Re-fetch the full record with populated relations to return fresh data
    const updated = await Attendance.findById(attendance._id).populate({
      path: 'user',
      select: 'name email mobile department designation profileImage shift',
      populate: { path: 'shift' }
    });

    return res.status(200).json({
      success: true,
      message: 'Attendance record updated successfully. All stats and reports have been recalculated.',
      data: updated
    });

  } catch (err) {
    return res.status(400).json({ success: false, message: err.message });
  }
};

// @desc    Update GPS status and notify admin if disabled
// @route   POST /api/attendance/gps-status
// @access  Private
exports.gpsStatusUpdate = async (req, res, next) => {
  try {
    const { gpsEnabled } = req.body;
    const userId = req.user.id;
    const io = req.app.get('io');

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // Update LiveEmployeeStatus signal quality/status
    const liveStatus = await LiveEmployeeStatus.findOne({ companyId: req.tenant.companyId, userId });
    if (liveStatus) {
      liveStatus.signalQuality = gpsEnabled ? 'strong' : 'lost';
      liveStatus.currentStatus = gpsEnabled ? 'online' : 'offline';
      liveStatus.lastUpdate = new Date();
      await liveStatus.save();
    }

    if (!gpsEnabled) {
      // Trigger notification to admin
      const notificationService = require('../services/notificationService');
      await notificationService.createAndSendNotification({
        title: 'Location Service Disabled 🚨',
        description: `Employee ${user.name} (${user.email}) has turned off their device location service or revoked permissions.`,
        type: 'emergency notification',
        frequency: 'Instant',
        targetType: 'Role-based Employees',
        targetRole: 'admin',
        companyId: user.companyId || req.tenant?.companyId || null,
        isAuto: false
      }, io);
    }

    res.status(200).json({ success: true });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

// @desc    Upload punch selfie (WebP conversion)
// @route   POST /api/attendance/upload-selfie
// @access  Private
exports.uploadPunchSelfie = async (req, res, next) => {
  try {
    const { attendanceId, type, selfie } = req.body;
    const userId = req.user.id;

    if (!attendanceId || !selfie || selfie === 'skipped' || selfie === 'pending_background_upload' || (typeof selfie === 'string' && (selfie.startsWith('file://') || selfie.startsWith('content://')))) {
      return res.status(400).json({ success: false, message: 'Missing attendanceId or valid selfie payload' });
    }

    const targetField = type === 'punchOut' ? 'punchOut.selfie' : 'punchIn.selfie';

    // Upload to Cloudinary with WebP conversion
    const selfieData = await uploadToCloudinary(selfie, 'hrms/attendance/selfies');
    if (selfieData?.url) {
      await Attendance.updateOne(
        { _id: attendanceId, user: userId },
        { $set: { [targetField]: selfieData.url } }
      );
      console.log(`[Attendance] Selfie WebP upload completed for ${targetField}:`, selfieData.url);
      return res.status(200).json({ success: true, url: selfieData.url, message: 'Selfie uploaded successfully' });
    }

    return res.status(500).json({ success: false, message: 'Failed to upload selfie' });
  } catch (err) {
    console.error(`[Attendance] Selfie upload error:`, err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};
