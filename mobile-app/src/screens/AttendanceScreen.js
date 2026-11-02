import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import * as Location from 'expo-location';
import {
  Camera,
  CheckCircle,
  ChevronRight,
  Coffee,
  Eye,
  MapPin,
  PlayCircle,
  RotateCcw,
  ShieldAlert,
  X
} from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  Image,
  Linking,
  Modal,
  Platform,
  RefreshControl,
  ScrollView,
  StatusBar,
  Text,
  TouchableOpacity,
  View
} from 'react-native';
import api from '../api/axios';
// import { useSidebar } from '../context/SidebarContext'; // SIDEBAR COMMENTED OUT
import AttendanceLivenessCapture from '../components/AttendanceLivenessCapture';
import HRModuleFooter from '../components/HRModuleFooter';
import socket from '../socket';
import { formatWorkingHours } from '../utils/timeFormat';

const LOCATION_TRACKING_TASK = 'background-location-tracking';

const getISTDateString = (date) => {
  if (!date) return null;
  const d = new Date(date);
  if (isNaN(d.getTime())) return null;
  // Shift by 5.5 hours to represent it in IST (UTC +5:30)
  const istTime = new Date(d.getTime() + (5.5 * 60 * 60 * 1000));
  const year = istTime.getUTCFullYear();
  const month = String(istTime.getUTCMonth() + 1).padStart(2, '0');
  const day = String(istTime.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const getSelfieUri = (s) => {
  if (!s || s === 'skipped') return null;
  if (typeof s === 'object') {
    if (s.uri) return s.uri;
    if (s.assets && s.assets[0]?.uri) return s.assets[0].uri;
    if (s.assets && s.assets[0]?.base64) {
      const b = s.assets[0].base64;
      return b.startsWith('data:') ? b : `data:image/jpeg;base64,${b}`;
    }
    if (s.base64) {
      const b = s.base64;
      return b.startsWith('data:') ? b : `data:image/jpeg;base64,${b}`;
    }
  }
  if (typeof s === 'string') {
    const str = s.trim();
    if (str.startsWith('http://') || str.startsWith('https://') || str.startsWith('file://') || str.startsWith('data:image/')) {
      return str;
    }
    if (str.length > 30) {
      return str.startsWith('data:') ? str : `data:image/jpeg;base64,${str}`;
    }
    return str;
  }
  return null;
};

const AttendanceScreen = ({ navigation }) => {
  // const { openSidebar } = useSidebar(); // SIDEBAR COMMENTED OUT
  useEffect(() => {
    const fetchData = () => {
      verifyBackgroundPermission();
      getLocation();
      fetchUser();
      fetchOfficeSettings();
      fetchLeaves();
    };

    fetchData();

    // Re-check permissions and location when app returns from Settings
    const appStateSub = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') {
        verifyBackgroundPermission();
        getLocation();
      }
    });

    const unsubscribe = navigation.addListener('focus', () => {
      fetchData();
    });

    return () => {
      appStateSub.remove();
      unsubscribe();
    };
  }, [navigation]);

  const [user, setUser] = useState(null);

  const [selfie, setSelfie] = useState(null);
  const [showLivenessCapture, setShowLivenessCapture] = useState(false);
  const [location, setLocation] = useState(null);
  const [locationLoading, setLocationLoading] = useState(true);
  const [punchLoading, setPunchLoading] = useState(false);
  const [punchLoadingMessage, setPunchLoadingMessage] = useState('');

  const [todayAttendance, setTodayAttendance] = useState(null);
  const [office, setOffice] = useState(null);
  const [distance, setDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [mapFull, setMapFull] = useState(false);
  const [previewImage, setPreviewImage] = useState(null);
  const [myLeaves, setMyLeaves] = useState([]);
  const [apiError, setApiError] = useState(null);

  const [toast, setToast] = useState({ show: false, message: '', type: 'success' });
  const [backendShiftStatus, setBackendShiftStatus] = useState(null);
  const [hasBackgroundPermission, setHasBackgroundPermission] = useState(null);

  const verifyBackgroundPermission = async () => {
    if (Platform.OS === 'android') {
      try {
        const bg = await Location.getBackgroundPermissionsAsync();
        const granted = bg?.status === 'granted';
        setHasBackgroundPermission(granted);
        return granted;
      } catch (_) {
        return true;
      }
    }
    return true;
  };

  const alreadyPunchedIn = !!todayAttendance?.punchIn?.time;
  const alreadyPunchedOut = !!todayAttendance?.punchOut?.time;

  const fetchUser = async () => {
    try {
      const res = await api.get('/auth/me');
      const userData = res.data?.data;
      setUser(userData);
      setTodayAttendance(res.data?.todayAttendance || null);
      setBackendShiftStatus(res.data?.shiftStatus || null);
      if (userData?._id) {
        try {
          socket.emit('join', userData._id);
          await AsyncStorage.setItem('userId', userData._id);
        } catch (_) { }
      }
      setApiError(null);
    } catch (err) {
      console.warn('[AttendanceScreen] fetchUser error:', err.message);
      if (err?.response?.status === 401) {
        return; // Session expired or employee removed — global auth interceptor handles redirect
      }
      setApiError(err?.response?.data?.message || 'Unable to connect to server. Please tap retry.');
    }
  };

  const fetchLeaves = async () => {
    try {
      const res = await api.get('/leaves/my-leaves');
      setMyLeaves(res.data?.data?.data || []);
    } catch (err) {
      console.warn('[AttendanceScreen] fetchLeaves error:', err.message);
    }
  };

  const fetchOfficeSettings = async () => {
    try {
      const res = await api.get('/settings/office');
      setOffice(res.data?.data || null);
    } catch (err) {
      console.warn('[AttendanceScreen] fetchOfficeSettings error:', err.message);
    }
  };

  const calculateDistance = (lat1, lon1, lat2, lon2) => {
    const R = 6371e3; // meters
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  };

  useEffect(() => {
    if (location && office) {
      const d = calculateDistance(
        location.latitude,
        location.longitude,
        office.latitude,
        office.longitude
      );
      setDistance(d);
    }
  }, [location, office]);

  // Re-fetch location when office settings change so geofence check updates fast
  const prevOfficeRef = useRef(null);
  useEffect(() => {
    if (office && prevOfficeRef.current) {
      const prev = prevOfficeRef.current;
      if (prev.latitude !== office.latitude || prev.longitude !== office.longitude || prev.radius !== office.radius) {
        getLocation();
      }
    }
    prevOfficeRef.current = office;
  }, [office]);

  // Ref to prevent geocode race conditions
  const geocodeRef = useRef(0);

  // Fast fused location resolver (fused watcher + low + balanced parallel race)
  const fetchFastLocationFix = () => {
    return new Promise(async (resolve) => {
      let resolved = false;
      let watchSub = null;

      const finish = (coords, source) => {
        if (!resolved && coords && typeof coords.latitude === 'number') {
          resolved = true;
          if (watchSub) {
            try { watchSub.remove(); } catch (e) { }
          }
          resolve(coords);
        }
      };

      // 1. One-shot watchPosition (GPS / Fused provider fires in 100-300ms on Android)
      try {
        watchSub = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.High,
            timeInterval: 300,
            distanceInterval: 0,
          },
          (loc) => {
            if (loc?.coords) finish(loc.coords, 'watchPositionAsync');
          }
        );
      } catch (watchErr) {
        // silent
      }

      // 2. Parallel Fast High Accuracy (Direct GPS / Mock GPS hardware fix)
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High })
        .then(res => { if (res?.coords) finish(res.coords, 'getCurrentPosition(High)'); })
        .catch(() => {});

      // 3. Parallel Balanced accuracy (Fast Network fix, silently handled)
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced })
        .then(res => { if (res?.coords) finish(res.coords, 'getCurrentPosition(Balanced)'); })
        .catch(() => {});

      // 4. Safety timeout: if nothing resolved in 4 seconds, finish
      setTimeout(() => {
        if (!resolved) {
          if (watchSub) {
            try { watchSub.remove(); } catch (e) { }
          }
          console.warn('[AttendanceScreen] Fast location resolver reached safety timeout');
          resolve(null);
        }
      }, 4000);
    });
  };

  // Dedicated Actual Address Resolver
  const resolveActualAddress = async (coords) => {
    if (!coords || typeof coords.latitude !== 'number' || typeof coords.longitude !== 'number') return null;
    let addr = null;

    // 1. Google Maps Geocoding API
    try {
      const MAPS_KEY = process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY || 'AIzaSyCP_wcD-7ZCxw_4DbVmiANpp5FE1Bk0JiI';
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3500);
      const geoRes = await fetch(
        `https://maps.googleapis.com/maps/api/geocode/json?latlng=${coords.latitude},${coords.longitude}&key=${MAPS_KEY}`,
        { signal: controller.signal }
      );
      clearTimeout(timer);
      const geoData = await geoRes.json();
      if (geoData.status === 'OK' && geoData.results.length > 0) {
        addr = geoData.results[0].formatted_address;
      }
    } catch (e) { }

    // 2. Native reverse geocoding fallback
    if (!addr) {
      try {
        const geocode = await Location.reverseGeocodeAsync({
          latitude: coords.latitude,
          longitude: coords.longitude,
        });
        if (geocode && geocode[0]) {
          const g = geocode[0];
          const parts = [g.name, g.street, g.city || g.subregion, g.region].filter(Boolean);
          if (parts.length > 0) {
            addr = parts.join(', ');
          }
        }
      } catch (geoErr) { }
    }
    return addr;
  };

  const getLocation = async () => {
    console.log('[AttendanceScreen] getLocation called');
    try {
      setLocationLoading(true);

      // 1. Check if location services are enabled on the phone
      try {
        const hasServices = await Location.hasServicesEnabledAsync();
        if (!hasServices) {
          try {
            await Location.enableNetworkProviderAsync();
          } catch (enableErr) { }

          const recheck = await Location.hasServicesEnabledAsync();
          if (!recheck) {
            setToast({ show: true, message: 'Please turn on GPS/Location on your device.', type: 'error' });
            setTimeout(() => setToast(prev => ({ ...prev, show: false })), 3000);
            setLocationLoading(false);
            return;
          }
        }
      } catch (svcErr) { }

      // 2. Check and request foreground permissions
      let { status: fgStatus } = await Location.getForegroundPermissionsAsync();
      if (fgStatus !== 'granted') {
        const req = await Location.requestForegroundPermissionsAsync();
        fgStatus = req.status;
      }

      if (fgStatus !== 'granted') {
        setToast({ show: true, message: 'Location permission is required to mark attendance.', type: 'error' });
        setTimeout(() => setToast(prev => ({ ...prev, show: false })), 3000);
        setLocationLoading(false);
        return;
      }

      // 3. STEP 0: Check OS / Hardware Last Known Position (0ms) & Immediately Update Range
      try {
        const lastKnown = await Location.getLastKnownPositionAsync();
        if (lastKnown && lastKnown.coords) {
          setLocation({
            ...lastKnown.coords,
            address: 'Detecting address...',
          });
          if (office && office.latitude && office.longitude) {
            const d = calculateDistance(lastKnown.coords.latitude, lastKnown.coords.longitude, office.latitude, office.longitude);
            setDistance(d);
          }
          setLocationLoading(false);
        }
      } catch (lastErr) { }

      // 4. STEP 1: Fast Fused Location Resolver & Instant Range Calculation
      const fastCoords = await fetchFastLocationFix();

      if (fastCoords) {
        setLocation(prev => ({
          ...fastCoords,
          address: prev?.address && prev.address !== 'Detecting address...' ? prev.address : 'Detecting address...',
        }));
        if (office && office.latitude && office.longitude) {
          const d = calculateDistance(fastCoords.latitude, fastCoords.longitude, office.latitude, office.longitude);
          setDistance(d);
        }
        setLocationLoading(false);
      } else if (!location) {
        // Fallback: try High accuracy as reliable GPS fix
        try {
          const fallbackLoc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
          if (fallbackLoc?.coords) {
            setLocation({
              ...fallbackLoc.coords,
              address: 'Detecting address...',
            });
            if (office && office.latitude && office.longitude) {
              const d = calculateDistance(fallbackLoc.coords.latitude, fallbackLoc.coords.longitude, office.latitude, office.longitude);
              setDistance(d);
            }
          }
        } catch (e) { }
      }

      setLocationLoading(false);

      // 5. STEP 2: Background Reverse Geocoding for clean actual address
      const targetLoc = fastCoords || location;
      if (targetLoc && targetLoc.latitude && targetLoc.longitude) {
        const geocodeId = ++geocodeRef.current;
        (async () => {
          const addr = await resolveActualAddress(targetLoc);
          if (addr && geocodeRef.current === geocodeId) {
            console.log('[AttendanceScreen] Reverse geocode resolved actual address:', addr);
            setLocation(prev => prev ? ({ ...prev, address: addr }) : prev);
          }
        })();
      }
    } catch (err) {
      console.error('[AttendanceScreen] getLocation top-level error:', err);
      setLocationLoading(false);
      setToast({ show: true, message: 'Could not detect location. Please tap retry.', type: 'error' });
      setTimeout(() => setToast(prev => ({ ...prev, show: false })), 2500);
    } finally {
      setLocationLoading(false);
    }
  };

  // Ensure attendance/complete day status is based on the current date
  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];
  // Use todayStr for filtering/comparing attendance records
  // Example usage:
  // const isDayComplete = attendanceRecords.some(record => record.date === todayStr && record.status === 'Present');
  const getShiftStatus = () => {
    if (alreadyPunchedIn && alreadyPunchedOut) {
      return { allowed: false, status: 'Completed', message: 'Attendance Complete' };
    }
    return { allowed: true };
  };

  const onRefresh = async () => {
    setRefreshing(true);
    await Promise.all([getLocation(), fetchUser(), fetchOfficeSettings(), fetchLeaves()]);
    setRefreshing(false);
  };

  // Enterprise Tracking Controller
  useEffect(() => {
    const punchedIn = !!todayAttendance?.punchIn?.time;
    const punchedOut = !!todayAttendance?.punchOut?.time;
    if (punchedIn && !punchedOut && todayAttendance?._id) {
      const { startTrackingSession } = require('../services/trackingManager');
      startTrackingSession(todayAttendance._id);
    }
  }, [todayAttendance]);

  const takeSelfie = async () => {
    setShowLivenessCapture(true);
  };

  // Helper: get current location quickly (for use when punching without pre-loaded location)
  const getQuickLocation = async () => {
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') return null;

      // 1. Instantaneous cached OS position (0ms)
      try {
        const lastKnown = await Location.getLastKnownPositionAsync();
        if (lastKnown?.coords) {
          const quickLoc = { ...lastKnown.coords, address: location?.address || 'Detecting address...' };
          setLocation(quickLoc);
          return quickLoc;
        }
      } catch (e) { }

      // 2. Fast fused resolver
      const fastCoords = await fetchFastLocationFix();
      if (fastCoords) {
        const quickLoc = { ...fastCoords, address: location?.address || 'Detecting address...' };
        setLocation(quickLoc);
        return quickLoc;
      }
    } catch (e) {
      console.warn('[AttendanceScreen] Quick location failed:', e.message);
    }
    return null;
  };

  // Helper: Extract selfie payload for API submission
  const getSelfiePayload = async (selfieObj) => {
    if (!selfieObj) return null;
    if (selfieObj.base64) {
      return selfieObj.base64.startsWith('data:') ? selfieObj.base64 : `data:image/jpeg;base64,${selfieObj.base64}`;
    }
    // Safe fallback: if base64 was dropped by camera memory, read from local URI
    if (selfieObj.uri) {
      try {
        const base64Data = await FileSystem.readAsStringAsync(selfieObj.uri, {
          encoding: FileSystem.EncodingType ? FileSystem.EncodingType.Base64 : 'base64',
        });
        if (base64Data) {
          return `data:image/jpeg;base64,${base64Data}`;
        }
      } catch (e) {
        console.warn('[AttendanceScreen] FileSystem readAsStringAsync error:', e.message);
      }
    }
    return 'skipped';
  };

  // Helper: Extract selfie URI for local preview
  const getSelfieUriForPreview = (selfieObj) => {
    if (!selfieObj) return null;
    return selfieObj.uri || (selfieObj.base64 ? (selfieObj.base64.startsWith('data:') ? selfieObj.base64 : `data:image/jpeg;base64,${selfieObj.base64}`) : null);
  };

  const handlePunchIn = async (bypassBgCheck = false) => {
    // 0. Check background location permission on Android (Warn & guide, allow bypass)
    if (Platform.OS === 'android' && !bypassBgCheck) {
      try {
        const bgPerm = await Location.getBackgroundPermissionsAsync();
        if (bgPerm?.status !== 'granted') {
          setHasBackgroundPermission(false);
          setPunchLoading(false);
          Alert.alert(
            'Background Location Recommended',
            'Location is set to "While using app". Live route tracking when your phone is locked requires "Allow all the time".\n\nConfigure in Settings or punch in anyway?',
            [
              { text: 'Open Settings', onPress: () => Linking.openSettings() },
              {
                text: 'Punch In Anyway',
                style: 'cancel',
                onPress: () => handlePunchIn(true)
              }
            ]
          );
          return;
        }
        setHasBackgroundPermission(true);
      } catch (permErr) {
        console.warn('[AttendanceScreen] Background permission check error:', permErr?.message);
      }
    }

    // 1. Ensure GPS Location Coordinates are ready
    let punchLocation = location;
    if (!punchLocation || typeof punchLocation.latitude !== 'number') {
      setPunchLoading(true);
      punchLocation = await getQuickLocation();
      if (!punchLocation || typeof punchLocation.latitude !== 'number') {
        setPunchLoading(false);
        setToast({ show: true, message: 'Could not detect GPS location. Please try again.', type: 'error' });
        setTimeout(() => setToast(prev => ({ ...prev, show: false })), 2500);
        return;
      }
    }

    // 2. Fast Non-blocking address resolution (Uses fast cached address or coordinates fallback for instant submission)
    let actualAddress = punchLocation.address;
    if (!actualAddress || actualAddress === 'Detecting address...' || actualAddress.includes('Detecting')) {
      actualAddress = office?.name || `GPS: ${punchLocation.latitude.toFixed(5)}, ${punchLocation.longitude.toFixed(5)}`;
      punchLocation = { ...punchLocation, address: actualAddress };
    }

    if (!selfie) {
      setToast({ show: true, message: 'Selfie is required for verification.', type: 'error' });
      setTimeout(() => setToast(prev => ({ ...prev, show: false })), 2000);
      return;
    }

    // Background location permission verified at top of handlePunchIn

    setPunchLoading(true);
    setPunchLoadingMessage('Verifying & Punching in...');
    setToast({ show: true, message: 'Verifying & Punching in...', type: 'info' });

    const capturedSelfiePayload = await getSelfiePayload(selfie);
    const capturedSelfieUri = getSelfieUriForPreview(selfie);

    try {
      // 1. Record punch-in session (Sends selfie directly; backend uploads to Cloudinary asynchronously in background)
      const res = await api.post('/attendance/punch-in', {
        latitude: punchLocation.latitude,
        longitude: punchLocation.longitude,
        address: punchLocation.address,
        selfie: capturedSelfiePayload,
      });

      const updated = res.data?.data;
      if (updated) {
        if (updated.punchIn && !updated.punchIn.selfie && capturedSelfieUri) {
          updated.punchIn.selfie = capturedSelfieUri;
        }
        setTodayAttendance(updated);
      }
      setSelfie(null); // Clear selfie after punch
      setToast({ show: true, message: 'Punched In successfully!', type: 'success' });
      setTimeout(() => {
        setToast(prev => ({ ...prev, show: false }));
      }, 2000);
    } catch (err) {
      setToast({ show: true, message: err.response?.data?.message || 'Could not punch in. Please try again.', type: 'error' });
      setTimeout(() => setToast(prev => ({ ...prev, show: false })), 2000);
    } finally {
      setPunchLoading(false);
      setPunchLoadingMessage('');
    }
  };

  const handlePunchOut = async () => {
    Alert.alert('Confirm Punch Out', 'Are you sure you want to end your shift?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Punch Out',
        style: 'destructive',
        onPress: async () => {
          if (!selfie) {
            setToast({ show: true, message: 'Selfie is required for verification.', type: 'error' });
            setTimeout(() => setToast(prev => ({ ...prev, show: false })), 2000);
            return;
          }

          // 1. Ensure GPS Location Coordinates are ready
          let punchLocation = location;
          if (!punchLocation || typeof punchLocation.latitude !== 'number') {
            setPunchLoading(true);
            punchLocation = await getQuickLocation();
            if (!punchLocation || typeof punchLocation.latitude !== 'number') {
              setPunchLoading(false);
              setToast({ show: true, message: 'Could not detect GPS location. Please try again.', type: 'error' });
              setTimeout(() => setToast(prev => ({ ...prev, show: false })), 2000);
              return;
            }
          }

          // 2. Fast Non-blocking address resolution (Uses fast cached address or coordinates fallback for instant submission)
          let actualAddress = punchLocation.address;
          if (!actualAddress || actualAddress === 'Detecting address...' || actualAddress.includes('Detecting')) {
            actualAddress = office?.name || `GPS: ${punchLocation.latitude.toFixed(5)}, ${punchLocation.longitude.toFixed(5)}`;
            punchLocation = { ...punchLocation, address: actualAddress };
          }

          setPunchLoading(true);
          setPunchLoadingMessage('Verifying & Punching out...');
          setToast({ show: true, message: 'Verifying & Punching out...', type: 'info' });

          const capturedSelfiePayload = await getSelfiePayload(selfie);
          const capturedSelfieUri = getSelfieUriForPreview(selfie);

          try {
            // 1. Record punch-out session (Sends selfie directly; backend uploads to Cloudinary asynchronously in background)
            const res = await api.post('/attendance/punch-out', {
              latitude: punchLocation.latitude,
              longitude: punchLocation.longitude,
              address: punchLocation.address,
              selfie: capturedSelfiePayload,
            });

            const updated = res.data?.data;
            if (updated) {
              if (updated.punchOut && !updated.punchOut.selfie && capturedSelfieUri) {
                updated.punchOut.selfie = capturedSelfieUri;
              }
              setTodayAttendance(updated);
            }
            setSelfie(null); // Clear selfie after punch
            // Clear persistent tracking session upon punch out
            try {
              const { clearTrackingSession } = require('../services/trackingManager');
              await clearTrackingSession();
            } catch (clearErr) {
              console.warn('Failed to clear tracking session:', clearErr);
            }

            setToast({ show: true, message: 'Punched Out successfully!', type: 'success' });
            setTimeout(() => {
              setToast(prev => ({ ...prev, show: false }));
            }, 2000);
          } catch (err) {
            setToast({ show: true, message: err.response?.data?.message || 'Could not punch out. Please try again.', type: 'error' });
            setTimeout(() => setToast(prev => ({ ...prev, show: false })), 2000);
          } finally {
            setPunchLoading(false);
            setPunchLoadingMessage('');
          }
        },
      },
    ]);
  };

  const executeToggleBreak = async () => {
    try {
      setPunchLoading(true);
      const res = await api.post('/attendance/break');
      setTodayAttendance(res.data.data);
      setToast({ show: true, message: res.data.message || 'Break updated', type: 'success' });
      setTimeout(() => setToast(prev => ({ ...prev, show: false })), 2000);
    } catch (err) {
      setToast({ show: true, message: err.response?.data?.message || 'Could not toggle break.', type: 'error' });
      setTimeout(() => setToast(prev => ({ ...prev, show: false })), 2000);
    } finally {
      setPunchLoading(false);
    }
  };

  const handleToggleBreak = () => {
    const isEnding = todayAttendance?.breaks?.some(b => !b.endTime);
    Alert.alert(
      isEnding ? 'End Break' : 'Start Break',
      isEnding
        ? 'Are you sure you want to end your break session and resume work?'
        : 'Are you sure you want to start a break session?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: isEnding ? 'End Break' : 'Start Break',
          onPress: executeToggleBreak,
        },
      ]
    );
  };

  return (
    <View className="flex-1 bg-slate-50">
      <StatusBar barStyle="dark-content" />

      {/* Header */}
      <View className="pt-14 px-6 pb-5 bg-blue-600 border-b border-slate-100 flex-row justify-between items-center">
        <View className="flex-row items-center">
          {/* SIDEBAR BUTTON COMMENTED OUT
          <TouchableOpacity
            className="w-10 h-10 rounded-xl bg-slate-50 justify-center items-center border border-slate-100 mr-4"
            onPress={openSidebar}
          >
            <Menu size={20} color="#64748b" />
          </TouchableOpacity>
          */}
          <View>
            <Text className="text-2xl font-extrabold text-white tracking-tight">Attendance</Text>
            <Text className="text-white font-bold text-xs">Verify location to mark</Text>
          </View>
        </View>
        <TouchableOpacity
          onPress={onRefresh}
          className="w-10 h-10 rounded-xl bg-slate-50 justify-center items-center border border-slate-100"
        >
          <RotateCcw size={18} color="#64748b" />
        </TouchableOpacity>
      </View>

      <ScrollView
        className="flex-1"
        contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 24, paddingBottom: 120 }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={['#4f46e5']} />
        }
      >
        {/* Connection Error Banner with Instant Retry */}
        {apiError && (
          <View className="bg-rose-50 border border-rose-200 rounded-2xl p-4 mb-4 flex-row items-center justify-between shadow-sm">
            <View className="flex-1 mr-3">
              <Text className="text-xs font-extrabold text-rose-800">Connection Error</Text>
              <Text className="text-[11px] text-rose-600 font-semibold mt-0.5">{apiError}</Text>
            </View>
            <TouchableOpacity
              onPress={() => {
                setApiError(null);
                getLocation();
                fetchUser();
                fetchOfficeSettings();
                fetchLeaves();
              }}
              className="bg-rose-600 px-3.5 py-2 rounded-xl flex-row items-center shadow-sm"
              activeOpacity={0.8}
            >
              <RotateCcw size={13} color="#ffffff" />
              <Text className="text-xs font-bold text-white ml-1.5">Retry</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Location Card */}
        <View className="bg-white rounded-3xl p-5 border border-slate-100 mb-5 shadow-sm">
          <View className="flex-row items-center">
            <View className="w-12 h-12 rounded-2xl bg-indigo-50 justify-center items-center">
              <MapPin size={22} color="#4f46e5" />
            </View>
            <View className="ml-4 flex-1">
              <Text className="text-[10px] font-bold text-slate-400 tracking-widest">YOUR LOCATION</Text>
              {locationLoading && !location ? (
                <View className="flex-row items-center mt-1">
                  <ActivityIndicator size="small" color="#4f46e5" />
                  <Text className="text-xs font-bold text-indigo-600 ml-2">Detecting location...</Text>
                </View>
              ) : location ? (
                <>
                  <Text className="text-sm font-bold text-slate-800 mt-0.5">{location.address || 'Detecting address...'}</Text>
                  <View className="flex-row items-center mt-1">
                    {office && distance <= office.radius ? (
                      <>
                        <CheckCircle size={12} color="#10b981" />
                        <Text className="text-xs font-bold text-emerald-600 ml-1">In Office Range</Text>
                      </>
                    ) : office ? (
                      <>
                        <X size={12} color="#f43f5e" />
                        <Text className="text-xs font-bold text-rose-500 ml-1">Outside Office · {Math.round(distance - office.radius)}m away</Text>
                      </>
                    ) : (
                      <>
                        <CheckCircle size={12} color="#10b981" />
                        <Text className="text-xs font-bold text-emerald-600 ml-1">Location Detected</Text>
                      </>
                    )}
                  </View>
                  {/* Subtle Outstation Indicator */}
                  {(todayAttendance?.isOutstation || (office && distance >= (office.outstationThreshold || 150000))) && (
                    <View className="mt-2.5 pt-2 border-t border-slate-100 flex-row items-center justify-between">
                      <View className="flex-row items-center flex-1 mr-5">
                        <View className="w-1.5 h-1.5 rounded-full bg-purple-600 mr-1.5" />
                        <Text className="text-[11px] font-bold text-purple-800">Outstation Duty</Text>
                        <Text className="text-[10px] text-slate-400 font-medium ml-1" numberOfLines={1}>
                          · {todayAttendance?.outstationDistanceKm || Math.round(distance / 1000)} km from office
                        </Text>
                      </View>
                      {/* <View className="bg-purple-50 border border-purple-200/60 px-1.5 py-0.5 rounded">
                        <Text className="text-[9px] font-bold text-purple-700 ml-2">150+ km</Text>
                      </View> */}
                    </View>
                  )}
                </>
              ) : (
                <View className="mt-1">
                  <Text className="text-sm font-bold text-rose-500">Location not detected</Text>
                  <TouchableOpacity
                    onPress={getLocation}
                    className="mt-1.5 bg-indigo-50 border border-indigo-200 rounded-xl px-2.5 py-1 flex-row items-center self-start"
                    activeOpacity={0.8}
                  >
                    <RotateCcw size={11} color="#4f46e5" />
                    <Text className="text-[11px] font-bold text-indigo-600 ml-1">Retry GPS Fix</Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
            <View className="flex-row items-center gap-2">
              <TouchableOpacity onPress={getLocation} className="p-2 bg-indigo-50 rounded-xl">
                <RotateCcw size={16} color="#4f46e5" />
              </TouchableOpacity>
            </View>
          </View>
        </View>

        {/* Selfie Section - only if punch action is pending */}
        {!alreadyPunchedOut && selfie && (() => {
          const selfieUri = selfie?.uri || (selfie?.base64 ? (selfie.base64.startsWith('data:') ? selfie.base64 : `data:image/jpeg;base64,${selfie.base64}`) : (typeof selfie === 'string' ? selfie : null));
          return (
            <View className="mb-5 items-center">
              <View className="w-48 h-48 rounded-3xl bg-slate-100 border-2 border-dashed border-emerald-400 overflow-hidden shadow-sm relative">
                {selfieUri ? (
                  <Image
                    source={{ uri: selfieUri }}
                    style={{ width: '100%', height: '100%' }}
                    resizeMode="cover"
                    onError={(e) => {
                      console.warn('[AttendanceScreen] Selfie preview render error:', e.nativeEvent?.error);
                    }}
                  />
                ) : null}

                {/* Top Left Eye (Preview) & Top Right X (Cancel/Retake) */}
                <TouchableOpacity
                  onPress={() => setPreviewImage(selfieUri)}
                  className="absolute top-2.5 left-2.5 w-8 h-8 rounded-full bg-black/60 justify-center items-center shadow-sm"
                  activeOpacity={0.7}
                >
                  <Eye size={16} color="white" />
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => {
                    setSelfie(null);
                    setShowLivenessCapture(true);
                  }}
                  accessibilityLabel="Retake attendance selfie with liveness check"
                  className="absolute top-2.5 right-2.5 w-8 h-8 rounded-full bg-indigo-600 justify-center items-center shadow-sm"
                  activeOpacity={0.7}
                >
                  <RotateCcw size={16} color="white" />
                </TouchableOpacity>
              </View>
              <Text className="text-[10px] font-bold text-slate-400 mt-1.5">Selfie captured</Text>
            </View>
          );
        })()}

        {/* Background Location Required Notice */}
        {Platform.OS === 'android' && !hasBackgroundPermission && !alreadyPunchedOut && (
          <View className="bg-amber-50 border border-amber-200 rounded-2xl p-4 mb-4 flex-row items-center justify-between">
            <View className="flex-1 mr-3">
              <View className="flex-row items-center mb-1">
                <ShieldAlert size={16} color="#d97706" />
                <Text className="text-amber-800 font-bold text-xs ml-1.5 uppercase tracking-wide">
                  Background Location Required
                </Text>
              </View>
              <Text className="text-amber-700 text-xs">
                Location is set to "While using app". Company policy requires "Allow all the time" to punch in.
              </Text>
            </View>
            <TouchableOpacity
              activeOpacity={0.8}
              onPress={() => Linking.openSettings()}
              className="bg-amber-600 px-3 py-2 rounded-xl"
            >
              <Text className="text-white font-bold text-xs">Settings</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Action Button */}
        {(() => {
          const activeShiftStatus = (backendShiftStatus && !backendShiftStatus.allowed) ? backendShiftStatus : getShiftStatus();
          // Shift being 'Upcoming' should not block employee from punching in early on a new day
          const isShiftBlocked = activeShiftStatus && !activeShiftStatus.allowed && activeShiftStatus.status !== 'Upcoming';
          if (alreadyPunchedOut || isShiftBlocked) {
            return (
              <View className="rounded-3xl p-8 items-center border bg-slate-100 border-slate-200">
                <View className="w-16 h-16 rounded-full justify-center items-center mb-4 bg-emerald-100">
                  <CheckCircle size={32} color="#10b981" />
                </View>
                <Text className="font-extrabold text-lg text-slate-800">
                  {alreadyPunchedOut ? 'Attendance Complete' : activeShiftStatus.message}
                </Text>
                <Text className="text-slate-500 font-bold text-sm mt-1 text-center">
                  {alreadyPunchedOut
                    ? 'You have finished your shift for today.'
                    : (activeShiftStatus.detail || 'Attendance is currently unavailable.')}
                </Text>
              </View>
            );
          }

          return (
            <TouchableOpacity
              className={`h-18 rounded-2xl justify-center items-center shadow-lg ${alreadyPunchedIn
                ? 'bg-rose-500 shadow-rose-200'
                : 'bg-indigo-600 shadow-indigo-200'
                }`}
              style={{ height: 64 }}
              onPress={async () => {
                if (Platform.OS === 'android' && !alreadyPunchedIn) {
                  const isBgOk = await verifyBackgroundPermission();
                  if (!isBgOk) {
                    Alert.alert(
                      'Background Location Recommended',
                      'Location is set to "While using app". Live route tracking when your phone is locked requires "Allow all the time".\n\nConfigure in Settings or punch in anyway?',
                      [
                        { text: 'Open Settings', onPress: () => Linking.openSettings() },
                        {
                          text: 'Punch In Anyway',
                          style: 'cancel',
                          onPress: () => {
                            if (!selfie) {
                              takeSelfie();
                            } else {
                              handlePunchIn(true);
                            }
                          }
                        }
                      ]
                    );
                    return;
                  }
                }
                if (!selfie) {
                  takeSelfie();
                } else {
                  if (alreadyPunchedIn) {
                    handlePunchOut();
                  } else {
                    handlePunchIn();
                  }
                }
              }}
              disabled={punchLoading}
              activeOpacity={0.85}
            >
              {punchLoading ? (
                <View className="flex-row items-center justify-center">
                  <ActivityIndicator color="white" className="mr-2" />
                  <Text className="text-white font-bold text-base">
                    {punchLoadingMessage || (alreadyPunchedIn ? 'Verifying & Punching out...' : 'Verifying & Punching in...')}
                  </Text>
                </View>
              ) : (
                <View className="flex-row items-center">
                  <Text className="text-white font-bold text-lg">
                    {alreadyPunchedIn ? (selfie ? 'Save & Punch Out' : 'Punch Out Now') : (selfie ? 'Save & Punch In' : 'Punch In Now')}
                  </Text>
                  <ChevronRight size={20} color="white" className="ml-2" />
                </View>
              )}
            </TouchableOpacity>
          );
        })()}

        {/* Recent Attendance / Today's Record Card (Shown below action button after punch-in) */}
        {alreadyPunchedIn && todayAttendance && (() => {
          const punchInSelfieUri = getSelfieUri(todayAttendance.punchIn?.selfie) || getSelfieUri(todayAttendance.selfie) || getSelfieUri(user?.profileImage);
          const punchOutSelfieUri = getSelfieUri(todayAttendance.punchOut?.selfie) || getSelfieUri(user?.profileImage);
          const punchInAddress = todayAttendance.punchIn?.location?.address ||
            (todayAttendance.punchIn?.location?.latitude ? `${todayAttendance.punchIn.location.latitude.toFixed(6)}, ${todayAttendance.punchIn.location.longitude.toFixed(6)}` : 'Location verified');
          const punchOutAddress = todayAttendance.punchOut?.location?.address ||
            (todayAttendance.punchOut?.location?.latitude ? `${todayAttendance.punchOut.location.latitude.toFixed(6)}, ${todayAttendance.punchOut.location.longitude.toFixed(6)}` : 'Location verified');

          return (
            <View className="bg-white w-full rounded-3xl p-5 border border-slate-100 mt-5 shadow-sm">
              <View className="flex-row justify-between items-center mb-3">
                <Text className="text-[10px] font-bold text-slate-400 tracking-widest">RECENT ATTENDANCE</Text>
                {todayAttendance.status && (
                  <View className={`px-2 py-0.5 rounded-md ${todayAttendance.status === 'Late' ? 'bg-amber-50' : todayAttendance.status === 'Half Day' ? 'bg-orange-50' : 'bg-emerald-50'}`}>
                    <Text className={`text-[8px] font-bold ${todayAttendance.status === 'Late' ? 'text-amber-600' : todayAttendance.status === 'Half Day' ? 'text-orange-600' : 'text-emerald-600'}`}>{todayAttendance.status}</Text>
                  </View>
                )}
              </View>

              {/* Time Metrics Grid */}
              <View className="flex-row justify-between items-center py-2 border-t border-slate-50">
                <View className="items-start flex-1">
                  <Text className="text-[8px] font-bold text-slate-400">In</Text>
                  <Text className="text-sm font-bold text-slate-800">{todayAttendance.punchIn?.time ? new Date(todayAttendance.punchIn.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '--:--'}</Text>
                </View>
                <View className="items-center flex-1">
                  <Text className="text-[8px] font-bold text-slate-400">Worked</Text>
                  <Text className="text-sm font-bold text-slate-800">
                    {formatWorkingHours(
                      todayAttendance.punchOut?.time
                        ? todayAttendance.workingHours
                        : (new Date() - new Date(todayAttendance.punchIn?.time) - (todayAttendance.breaks?.reduce((acc, b) => acc + (b.duration || 0), 0) * 60000)) / 3600000
                    )}
                  </Text>
                </View>
                <View className="items-center flex-1">
                  <View className="flex-row items-center">
                    <Text className="text-[8px] font-bold text-slate-400">Break</Text>
                    <View className="ml-1 px-1 bg-amber-50 rounded">
                      <Text className="text-[6px] font-bold text-amber-600">{todayAttendance.breaks?.length || 0}</Text>
                    </View>
                  </View>
                  <Text className="text-sm font-bold text-amber-600">
                    {Math.floor((todayAttendance.breaks?.reduce((acc, b) => acc + (b.duration || 0), 0) || 0) / 60)}h {(todayAttendance.breaks?.reduce((acc, b) => acc + (b.duration || 0), 0) || 0) % 60}m
                  </Text>
                </View>
                <View className="items-end flex-1">
                  <Text className="text-[8px] font-bold text-slate-400">Out</Text>
                  <Text className="text-sm font-bold text-slate-800">{todayAttendance.punchOut?.time ? new Date(todayAttendance.punchOut.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '--:--'}</Text>
                </View>
              </View>

              {/* Punch In Details: Selfie + Full Untruncated Location */}
              <View className="mt-3 pt-3 border-t border-slate-100 bg-slate-50/70 p-3 rounded-2xl">
                <View className="flex-row items-center justify-between mb-2">
                  <View className="flex-row items-center">
                    <View className="w-2 h-2 rounded-full bg-emerald-500 mr-2" />
                    <Text className="text-[10px] font-extrabold text-slate-700 tracking-wide">PUNCH IN DETAILS</Text>
                  </View>
                </View>

                <View className="flex-row items-start">
                  {punchInSelfieUri ? (
                    <TouchableOpacity
                      onPress={() => setPreviewImage(punchInSelfieUri)}
                      activeOpacity={0.8}
                      className="w-16 h-16 rounded-xl overflow-hidden bg-slate-200 border border-slate-200 mr-3 relative shadow-sm"
                    >
                      <Image
                        source={{ uri: punchInSelfieUri }}
                        style={{ width: '100%', height: '100%' }}
                        resizeMode="cover"
                      />
                      <View className="absolute bottom-1 right-1 w-5 h-5 rounded-full bg-black/60 justify-center items-center">
                        <Eye size={10} color="white" />
                      </View>
                    </TouchableOpacity>
                  ) : (
                    <View className="w-16 h-16 rounded-xl bg-slate-200/80 border border-slate-300 mr-3 justify-center items-center">
                      <Camera size={20} color="#64748b" />
                      <Text className="text-[8px] font-bold text-slate-500 mt-0.5">Selfie</Text>
                    </View>
                  )}

                  <View className="flex-1 justify-center">
                    <View className="flex-row items-start">
                      <MapPin size={13} color="#4f46e5" style={{ marginTop: 2, marginRight: 4 }} />
                      <Text className="text-sm font-semibold text-slate-700 leading-snug flex-1 flex-wrap">
                        {punchInAddress}
                      </Text>
                    </View>
                  </View>
                </View>
              </View>

              {/* Punch Out Details: Selfie + Full Untruncated Location (if punched out) */}
              {todayAttendance.punchOut?.time && (
                <View className="mt-2.5 bg-rose-50/50 p-3 rounded-2xl border border-rose-100/60">
                  <View className="flex-row items-center justify-between mb-2">
                    <View className="flex-row items-center">
                      <View className="w-2 h-2 rounded-full bg-rose-500 mr-2" />
                      <Text className="text-[10px] font-extrabold text-slate-700 tracking-wide">PUNCH OUT DETAILS</Text>
                    </View>
                  </View>

                  <View className="flex-row items-start">
                    {punchOutSelfieUri ? (
                      <TouchableOpacity
                        onPress={() => setPreviewImage(punchOutSelfieUri)}
                        activeOpacity={0.8}
                        className="w-16 h-16 rounded-xl overflow-hidden bg-slate-200 border border-slate-200 mr-3 relative shadow-sm"
                      >
                        <Image
                          source={{ uri: punchOutSelfieUri }}
                          style={{ width: '100%', height: '100%' }}
                          resizeMode="cover"
                        />
                        <View className="absolute bottom-1 right-1 w-5 h-5 rounded-full bg-black/60 justify-center items-center">
                          <Eye size={10} color="white" />
                        </View>
                      </TouchableOpacity>
                    ) : (
                      <View className="w-16 h-16 rounded-xl bg-rose-100/80 border border-rose-200 mr-3 justify-center items-center">
                        <Camera size={20} color="#e11d48" />
                        <Text className="text-[8px] font-bold text-rose-500 mt-0.5">Selfie</Text>
                      </View>
                    )}

                    <View className="flex-1 justify-center">
                      <View className="flex-row items-start">
                        <MapPin size={13} color="#e11d48" style={{ marginTop: 2, marginRight: 4 }} />
                        <Text className="text-sm font-semibold text-slate-700 leading-snug flex-1 flex-wrap">
                          {punchOutAddress}
                        </Text>
                      </View>
                    </View>
                  </View>
                </View>
              )}

              {!alreadyPunchedOut && (
                <TouchableOpacity
                  onPress={handleToggleBreak}
                  activeOpacity={0.8}
                  className={`mt-4 h-14 rounded-2xl flex-row justify-center items-center border ${todayAttendance.breaks?.some(b => !b.endTime) ? 'bg-emerald-50 border-emerald-200' : 'bg-amber-50 border-amber-200'}`}
                >
                  {todayAttendance.breaks?.some(b => !b.endTime) ? (
                    <>
                      <PlayCircle size={20} color="#10b981" />
                      <Text className="ml-3 font-bold text-emerald-600">END BREAK SESSION</Text>
                    </>
                  ) : (
                    <>
                      <Coffee size={20} color="#f59e0b" />
                      <Text className="ml-3 font-bold text-amber-600">START BREAK SESSION</Text>
                    </>
                  )}
                </TouchableOpacity>
              )}
            </View>
          );
        })()}


      </ScrollView>

      <AttendanceLivenessCapture
        visible={showLivenessCapture}
        onCancel={() => setShowLivenessCapture(false)}
        onCapture={(photo) => {
          setSelfie(photo);
          setShowLivenessCapture(false);
        }}
      />

      {/* Full Screen Image Preview Modal */}
      <Modal visible={!!previewImage} transparent={true} animationType="fade">
        <View className="flex-1 bg-black/90 justify-center items-center">
          <TouchableOpacity
            onPress={() => setPreviewImage(null)}
            className="absolute top-14 right-6 w-12 h-12 bg-white/10 rounded-2xl justify-center items-center border border-white/20"
          >
            <X size={24} color="white" />
          </TouchableOpacity>
          <Image
            source={{ uri: previewImage }}
            style={{ width: '100%', height: '70%', borderRadius: 24 }}
            resizeMode="contain"
          />
          <View className="absolute bottom-14 bg-white/10 px-6 py-3 rounded-2xl border border-white/20">
            <Text className="text-white font-bold text-sm">Selfie Verification Proof</Text>
          </View>
        </View>
      </Modal>

      {/* Bottom Toast Notification */}
      {toast.show && (
        <View className={`absolute bottom-20 left-6 right-6 p-4 rounded-2xl shadow-2xl flex-row items-center border ${toast.type === 'success'
          ? 'bg-emerald-500 border-emerald-400'
          : toast.type === 'info'
            ? 'bg-indigo-600 border-indigo-500'
            : 'bg-rose-500 border-rose-400'
          }`}>
          {toast.type === 'info' && <ActivityIndicator color="white" size="small" style={{ marginRight: 8 }} />}
          <Text className="text-white font-bold text-sm text-center flex-1">{toast.message}</Text>
        </View>
      )}

      {/* HR Module Footer */}
      <HRModuleFooter navigation={navigation} currentScreen="attendance" />
    </View>
  );
};

export default AttendanceScreen;
