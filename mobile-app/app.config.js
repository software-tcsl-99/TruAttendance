const path = require('path');
try {
  require('dotenv').config({ path: path.resolve(__dirname, '.env') });
} catch (e) {}

const googleMapsApiKey = process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY || "AIzaSyCP_wcD-7ZCxw_4DbVmiANpp5FE1Bk0JiI";

module.exports = ({ config }) => {
  return {
    ...config,
    updates: {
      url: "https://u.expo.dev/787038e4-7225-4787-a053-519c618c6ef2",
      enabled: true,
      checkAutomatically: "ON_LOAD",
      fallbackToCacheTimeout: 10000,
      ...(config.updates || {}),
    },
    runtimeVersion: config.runtimeVersion || {
      policy: "appVersion",
    },
    extra: {
      ...(config.extra || {}),
      eas: {
        projectId: "787038e4-7225-4787-a053-519c618c6ef2",
        ...(config.extra?.eas || {}),
      },
    },
    plugins: [
      ...(config.plugins || []),
      "expo-sqlite",
      [
        "@rbayuokt/expo-face-vision",
        {
          cameraPermission: "Camera access is required to verify attendance liveness.",
        },
      ],
      ["expo-location", {
        locationAlwaysAndWhenInUsePermission: "Allow Geo-Track HRMS to access your location for attendance tracking.",
        isAndroidBackgroundLocationEnabled: true,
        isAndroidForegroundServiceEnabled: true
      }],
      ["react-native-maps", {
        "androidGoogleMapsApiKey": googleMapsApiKey
      }]
    ],
    android: {
      ...config.android,
      config: {
        ...config.android?.config,
        googleMaps: {
          apiKey: googleMapsApiKey
        }
      }
    }
  };
};
