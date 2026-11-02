const mongoose = require('mongoose');
const Location = require('../models/Location');
const CompanySetting = require('../models/CompanySetting');
const User = require('../models/User');
const trackingCache = require('../services/trackingCache');

// @desc    Get office settings
// @route   GET /api/settings/office
// @access  Private
exports.getOfficeSettings = async (req, res, next) => {
  try {
    const companyId = req.tenant.companyId;
    let office = await CompanySetting.findOne({ companyId });
    
    if (!office) {
      // Create default if not exists
      office = await CompanySetting.create({
        companyId,
        officeLocation: {
          latitude: 18.5204,
          longitude: 73.8567,
          address: 'Office Headquarters',
          radius: 200,
          geofenceEnabled: true
        }
      });
    }

    // Check if logged-in user is an employee and has an assigned workingPlace
    const user = await User.findById(req.user.id).populate('workingPlace');
    const firstLoc = await Location.findOne({ companyId }).sort({ createdAt: 1 });
    let responseData = {};

    if (user && user.workingPlace) {
      responseData = {
        _id: user.workingPlace._id,
        name: user.workingPlace.name || 'Office Main',
        latitude: user.workingPlace.latitude,
        longitude: user.workingPlace.longitude,
        address: user.workingPlace.address || '',
        radius: user.workingPlace.radius || 200,
        geofenceEnabled: user.workingPlace.geofenceEnabled !== undefined ? user.workingPlace.geofenceEnabled : true,
        weeklyOffs: office.weeklyOffs,
        globalHolidays: office.globalHolidays,
        leaveTypesEnabled: office.leaveTypesEnabled,
        androidApkUrl: office.androidApkUrl || process.env.ANDROID_APK_URL || '',
        iosAppUrl: office.iosAppUrl || process.env.IOS_APP_URL || '',
        minAndroidVersion: office.minAndroidVersion || '1.0.0',
        minAndroidVersionCode: office.minAndroidVersionCode || 1,
        forceUpdateEnabled: office.forceUpdateEnabled || false,
        updateMessage: office.updateMessage || '',
        orgCode: office.orgCode || 'TC',
        roleGrades: office.roleGrades || [],
      };
    } else {
      responseData = {
        _id: firstLoc?._id || office._id,
        name: firstLoc?.name || 'Primary Office',
        latitude: firstLoc?.latitude || office.officeLocation?.latitude || 18.5204,
        longitude: firstLoc?.longitude || office.officeLocation?.longitude || 73.8567,
        address: firstLoc?.address || office.officeLocation?.address || 'Office Location',
        radius: firstLoc?.radius || office.officeLocation?.radius || 200,
        geofenceEnabled: firstLoc ? (firstLoc.geofenceEnabled !== undefined ? firstLoc.geofenceEnabled : true) : (office.officeLocation?.geofenceEnabled !== undefined ? office.officeLocation.geofenceEnabled : true),
        weeklyOffs: office.weeklyOffs,
        globalHolidays: office.globalHolidays,
        leaveTypesEnabled: office.leaveTypesEnabled,
        androidApkUrl: office.androidApkUrl || process.env.ANDROID_APK_URL || '',
        iosAppUrl: office.iosAppUrl || process.env.IOS_APP_URL || '',
        minAndroidVersion: office.minAndroidVersion || '1.0.0',
        minAndroidVersionCode: office.minAndroidVersionCode || 1,
        forceUpdateEnabled: office.forceUpdateEnabled || false,
        updateMessage: office.updateMessage || '',
        orgCode: office.orgCode || 'TC',
        roleGrades: office.roleGrades || [],
      };
    }

    res.status(200).json({
      success: true,
      data: responseData,
    });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

// @desc    Get public app version for force update check
// @route   GET /api/settings/public-version
// @access  Public
exports.getPublicAppVersion = async (req, res) => {
  try {
    const office = await CompanySetting.findOne().sort({ createdAt: 1 });
    const forceUpdateDisabled = process.env.DISABLE_FORCE_APP_UPDATE === 'true';
    return res.status(200).json({
      success: true,
      data: {
        minAndroidVersion: office?.minAndroidVersion || '1.0.0',
        minAndroidVersionCode: office?.minAndroidVersionCode || 1,
        androidApkUrl: office?.androidApkUrl || process.env.ANDROID_APK_URL || '',
        iosAppUrl: office?.iosAppUrl || process.env.IOS_APP_URL || '',
        forceUpdateEnabled: !forceUpdateDisabled && Boolean(office?.forceUpdateEnabled),
        updateMessage: office?.updateMessage || 'A newer version of the application is available. Please update the app to continue.',
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// @desc    Update office settings
// @route   PUT /api/settings/office
// @access  Private/Admin
exports.updateOfficeSettings = async (req, res, next) => {
  try {
    let office = await CompanySetting.findOneAndUpdate(
      { companyId: req.tenant.companyId },
      { ...req.body, companyId: req.tenant.companyId },
      { new: true, runValidators: true, upsert: true }
    );
    // Invalidate cache — geofence/office location may have changed
    trackingCache.invalidateGeofences(req.tenant.companyId);
    trackingCache.invalidateConfig(req.tenant.companyId);

    res.status(200).json({
      success: true,
      data: office,
    });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

// @desc    Get all working places
// @route   GET /api/settings/locations
// @access  Private/Admin
// @desc    Get all working places
// @route   GET /api/settings/locations
// @access  Private/Admin
exports.getLocations = async (req, res, next) => {
  try {
    const companyId = req.tenant?.companyId || req.user?.companyId || req.user?.company || req.headers['x-company-id'] || null;
    const companyFilter = companyId ? { companyId } : {};
    const locations = await Location.find(companyFilter);

    let targetCompanyId = null;
    if (companyId) {
      targetCompanyId = mongoose.Types.ObjectId.isValid(companyId) ? new mongoose.Types.ObjectId(companyId) : companyId;
    }

    const matchFilter = {
      status: { $in: ['active', 'ACTIVE'] }
    };
    if (targetCompanyId) {
      matchFilter.$or = [
        { companyId: targetCompanyId },
        { company: targetCompanyId }
      ];
    }

    const employeeCounts = await User.aggregate([
      { $match: matchFilter },
      { $group: { _id: '$workingPlace', count: { $sum: 1 } } }
    ]);

    const countMap = {};
    employeeCounts.forEach(item => {
      if (item._id) {
        const key = String(item._id).trim().toLowerCase();
        countMap[key] = (countMap[key] || 0) + item.count;
      }
    });

    const dataWithCount = locations.map(loc => {
      const locObj = loc.toObject ? loc.toObject() : loc;
      const idKey = loc._id ? loc._id.toString().toLowerCase() : '';
      const nameKey = (loc.name || '').trim().toLowerCase();
      locObj.employeeCount = countMap[idKey] || countMap[nameKey] || 0;
      return locObj;
    });

    res.status(200).json({ success: true, count: locations.length, data: dataWithCount });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

// @desc    Create working place
// @route   POST /api/settings/locations
// @access  Private/Admin
exports.createLocation = async (req, res, next) => {
  try {
    const Company = require('../models/Company');
    let companyId = req.tenant?.companyId || req.user?.companyId || req.user?.company || req.headers['x-company-id'] || null;
    if (!companyId) {
      const primaryComp = await Company.findOne({ status: { $nin: ['SUSPENDED', 'INACTIVE', 'inactive'] } });
      companyId = primaryComp?._id || null;
    }

    if (!companyId) {
      return res.status(400).json({ success: false, message: 'Working place must belong to a company. Please select a company.' });
    }

    const location = await Location.create({ ...req.body, companyId });
    trackingCache.invalidateGeofences(companyId);
    res.status(201).json({ success: true, data: location });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({
        success: false,
        message: `A working place named "${req.body.name || 'this'}" already exists in your company. Please choose a unique name.`
      });
    }
    res.status(400).json({ success: false, message: err.message });
  }
};

// @desc    Update working place
// @route   PUT /api/settings/locations/:id
// @access  Private/Admin
exports.updateLocation = async (req, res, next) => {
  try {
    let companyId = req.tenant?.companyId || req.user?.companyId || req.user?.company || req.headers['x-company-id'] || null;
    const query = companyId ? { _id: req.params.id, companyId } : { _id: req.params.id };

    let location = await Location.findOneAndUpdate(query, req.body, {
      new: true,
      runValidators: true,
    });

    // Fallback if companyId mismatch on legacy record
    if (!location) {
      location = await Location.findByIdAndUpdate(req.params.id, req.body, {
        new: true,
        runValidators: true,
      });
    }

    if (!location) return res.status(404).json({ success: false, message: 'Location not found' });
    if (companyId) trackingCache.invalidateGeofences(companyId);
    res.status(200).json({ success: true, data: location });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({
        success: false,
        message: `A working place named "${req.body.name || 'this'}" already exists in your company. Please choose a unique name.`
      });
    }
    res.status(400).json({ success: false, message: err.message });
  }
};

// @desc    Delete working place
// @route   DELETE /api/settings/locations/:id
// @access  Private/Admin
exports.deleteLocation = async (req, res, next) => {
  try {
    let companyId = req.tenant?.companyId || req.user?.companyId || req.user?.company || req.headers['x-company-id'] || null;
    const query = companyId ? { _id: req.params.id, companyId } : { _id: req.params.id };

    let location = await Location.findOneAndDelete(query);
    if (!location) {
      location = await Location.findByIdAndDelete(req.params.id);
    }

    if (!location) return res.status(404).json({ success: false, message: 'Location not found' });
    if (companyId) trackingCache.invalidateGeofences(companyId);
    res.status(200).json({ success: true, data: {} });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

// @desc    Seed comprehensive database
// @route   POST /api/settings/seed-db
// @access  Private/Admin
exports.seedDatabase = async (req, res, next) => {
  try {
    const { fork } = require('child_process');
    const path = require('path');
    const scriptPath = path.join(__dirname, '../scripts/seed_comprehensive.js');

    const child = fork(scriptPath, [], {
      env: { ...process.env }
    });

    child.on('error', (err) => {
      console.error('Seed process error:', err);
    });

    const exitCode = await new Promise((resolve) => {
      child.on('exit', (code) => {
        resolve(code);
      });
    });

    if (exitCode === 0) {
      res.status(200).json({
        success: true,
        message: 'Database seeded successfully.'
      });
    } else {
      res.status(500).json({
        success: false,
        message: `Database seeding failed with exit code ${exitCode}.`
      });
    }
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc    Get role hierarchy configuration
// @route   GET /api/settings/role-config
// @access  Private
exports.getRoleConfig = async (req, res, next) => {
  try {
    let settings = await CompanySetting.findOne({ companyId: req.tenant.companyId });
    if (!settings) {
      settings = await CompanySetting.create({ companyId: req.tenant.companyId });
    }
    res.status(200).json({
      success: true,
      data: {
        orgCode: settings.orgCode || 'TC',
        roleGrades: settings.roleGrades || [],
      },
    });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

// @desc    Update role hierarchy configuration
// @route   PUT /api/settings/role-config
// @access  Private/Admin
exports.updateRoleConfig = async (req, res, next) => {
  try {
    const { orgCode, roleLevels, roleGrades } = req.body;
    const updateData = {};

    if (orgCode !== undefined) {
      if (!orgCode || orgCode.length < 1 || orgCode.length > 5) {
        return res.status(400).json({ success: false, message: 'Organization code must be 1-5 characters' });
      }
      updateData.orgCode = orgCode.toUpperCase();
    }

    if (roleGrades !== undefined) {
      if (!Array.isArray(roleGrades) || roleGrades.length === 0) {
        return res.status(400).json({ success: false, message: 'At least one role grade is required' });
      }
      updateData.roleGrades = roleGrades;
    }

    const settings = await CompanySetting.findOneAndUpdate(
      { companyId: req.tenant.companyId },
      { ...updateData, companyId: req.tenant.companyId },
      { new: true, runValidators: true, upsert: true }
    );

    res.status(200).json({
      success: true,
      data: {
        orgCode: settings.orgCode,
        roleGrades: settings.roleGrades,
      },
    });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};
