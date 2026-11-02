import AsyncStorage from "@react-native-async-storage/async-storage";
import { NavigationContainer } from "@react-navigation/native";
import { createStackNavigator } from "@react-navigation/stack";
import * as Battery from "expo-battery";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  Linking,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { enableScreens } from "react-native-screens";

enableScreens();

import { LogBox } from "react-native";
import ErrorBoundary from "./src/components/ErrorBoundary";
// import SidebarDrawer from './src/components/SidebarDrawer'; // SIDEBAR COMMENTED OUT
import { SidebarProvider } from "./src/context/SidebarContext";
import AttendanceScreen from "./src/screens/AttendanceScreen";
import CustomerVisitScreen from "./src/screens/CustomerVisitScreen";
import DashboardScreen from "./src/screens/DashboardScreen";
import HRScreen from "./src/screens/HRScreen";
import LeaveScreen from "./src/screens/LeaveScreen";
import LoginScreen from "./src/screens/LoginScreen";
import MonthlyViewScreen from "./src/screens/MonthlyViewScreen";
import ProfileScreen from "./src/screens/ProfileScreen";
import ShiftManagementScreen from "./src/screens/ShiftManagementScreen";
import OrgChartScreen from "./src/screens/OrgChartScreen";
import LeaveApprovalsScreen from "./src/screens/LeaveApprovalsScreen";
import ReportsScreen from "./src/screens/ReportsScreen";
import { navigationRef } from "./src/utils/navigation";
import { setupNotificationResponseListener, checkInitialNotificationResponse } from "./src/utils/notifications";
import * as Application from "expo-application";
import ForceUpdateModal from "./src/components/ForceUpdateModal";
import api from "./src/api/axios";

// Material Management Module Screens
import MaterialDashboardScreen from "./src/modules/material/screens/MaterialDashboardScreen";
import MaterialRequestScreen from "./src/modules/material/screens/MaterialRequestScreen";
import MaterialListScreen from "./src/modules/material/screens/MaterialListScreen";
import MaterialDetailScreen from "./src/modules/material/screens/MaterialDetailScreen";
import BarcodeViewAllScreen from "./src/modules/material/screens/BarcodeViewAllScreen";
import BarcodeDetailScreen from "./src/modules/material/screens/BarcodeDetailScreen";
import TransferMaterialScreen from "./src/modules/material/screens/TransferMaterialScreen";
import ReturnMaterialScreen from "./src/modules/material/screens/ReturnMaterialScreen";
import SplitMaterialScreen from "./src/modules/material/screens/SplitMaterialScreen";
import ConvertMaterialScreen from "./src/modules/material/screens/ConvertMaterialScreen";
import HandlerAssignmentScreen from "./src/modules/material/screens/HandlerAssignmentScreen";
import StoreDispatchScreen from "./src/modules/material/screens/StoreDispatchScreen";
import ReceivingFormScreen from "./src/modules/material/screens/ReceivingFormScreen";
import ExchangeBarcodeScreen from "./src/modules/material/screens/ExchangeBarcodeScreen";
import MaterialsTreeScreen from "./src/modules/material/screens/MaterialsTreeScreen";
import TransferListScreen from "./src/modules/material/screens/TransferListScreen";
import ReturnListScreen from "./src/modules/material/screens/ReturnListScreen";
import PendingTransactionsScreen from "./src/modules/material/screens/PendingTransactionsScreen";
import MaterialMovementHubScreen from "./src/modules/material/screens/MaterialMovementHubScreen";
import MergeMaterialScreen from "./src/modules/material/screens/MergeMaterialScreen";
import ReturnMultipleScreen from "./src/modules/material/screens/ReturnMultipleScreen";

// Expense Management (HR Module) Screens
import ExpenseDashboardScreen from "./src/modules/hr/expense/screens/ExpenseDashboardScreen";
import CreateExpenseClaimScreen from "./src/modules/hr/expense/screens/CreateExpenseClaimScreen";
import ExpenseClaimDetailScreen from "./src/modules/hr/expense/screens/ExpenseClaimDetailScreen";
import OtherApprovalsScreen from "./src/modules/hr/expense/screens/OtherApprovalsScreen";

if (!__DEV__) {
  LogBox.ignoreAllLogs(true);
}

const LOCATION_TRACKING_TASK = "background-location-tracking";

// Background Task Definition — Enterprise Pipeline (Single GPS System)
// This is the ONLY GPS collection mechanism. No watchPositionAsync.
try {
  const Constants = require("expo-constants").default;
  const isExpoGo =
    Constants?.appOwnership === "expo" ||
    Constants?.executionEnvironment === "storeClient";
  if (!isExpoGo && typeof TaskManager?.defineTask === "function") {
    TaskManager.defineTask(LOCATION_TRACKING_TASK, async ({ data, error }) => {
      if (error) return;
      if (data) {
        const { locations } = data;
        if (locations && locations.length > 0) {
          try {
            const {
              insertTrackingPoint,
              initDatabase,
            } = require("./src/services/database.service");
            const { syncPendingPoints } = require("./src/services/sync.service");
            const { setLastPoint } = require("./src/services/tracking.service");

            await initDatabase();

            const activeTripId = await AsyncStorage.getItem("activeTripId");
            const deviceId = await AsyncStorage.getItem("deviceId");

            let batteryLevel = 100;
            try {
              const level = await Battery.getBatteryLevelAsync();
              if (level >= 0) {
                batteryLevel = Math.round(level * 100);
              }
            } catch (batErr) {
              console.warn(
                "[BackgroundLocation] Failed to read battery level:",
                batErr.message,
              );
            }

            for (const loc of locations) {
              const {
                latitude,
                longitude,
                accuracy,
                speed,
                heading,
                altitude,
                mocked,
              } = loc.coords;
              const timestamp = loc.timestamp || Date.now();
              await insertTrackingPoint({
                latitude,
                longitude,
                accuracy,
                speed: speed || 0,
                heading: heading || 0,
                altitude: altitude || 0,
                timestamp: timestamp,
                tripId: activeTripId,
                deviceId: deviceId || "background-unknown",
                battery: batteryLevel,
                isOffline: accuracy > 50,
                isMock: mocked || false,
              });

              // Update lastPoint in tracking.service.js so heartbeat knows GPS is active
              setLastPoint({
                latitude,
                longitude,
                timestamp,
                tripId: activeTripId,
              });
            }

            // Trigger immediate background sync (force=true bypasses rate limiter during sleep)
            await syncPendingPoints(true);
          } catch (enterpriseErr) {
            // Fallback to legacy offlineQueue
            try {
              const {
                addPointToQueue,
                syncQueue,
              } = require("./src/utils/offlineQueue");
              for (const loc of locations) {
                const {
                  latitude,
                  longitude,
                  accuracy,
                  speed,
                  heading,
                  mocked,
                  timestamp,
                } = loc.coords;
                await addPointToQueue({
                  latitude,
                  longitude,
                  accuracy,
                  speed: speed || 0,
                  heading,
                  isMock: mocked,
                  timestamp: timestamp || Date.now(),
                });
              }
              await syncQueue();
            } catch (fallbackErr) {
              console.error(
                "[BackgroundTask] Both enterprise and fallback sync failed",
              );
            }
          }
        }
      }
    });
  }
} catch (taskErr) {
  console.warn("[TaskManager] Task definition skipped:", taskErr?.message);
}

const RootStack = createStackNavigator();

import PreLoginPermissionScreen from "./src/screens/PreLoginPermissionScreen";

export default function App() {
  const [permissionsGranted, setPermissionsGranted] = useState(false);
  const [checkingPermissions, setCheckingPermissions] = useState(true);
  const [updateRequired, setUpdateRequired] = useState(false);
  const [updateInfo, setUpdateInfo] = useState(null);
  const [installedVersion, setInstalledVersion] = useState("1.0.0");
  const [installedBuild, setInstalledBuild] = useState("1");

  const checkAppVersion = async () => {
    try {
      const currentVer = Application.nativeApplicationVersion || "1.0.0";
      const currentBld = Application.nativeBuildVersion || "1";
      setInstalledVersion(currentVer);
      setInstalledBuild(currentBld);

      const res = await api.get("/settings/public-version").catch(() => null);
      if (res?.data?.success && res?.data?.data) {
        const info = res.data.data;
        const requiredBuild = Number(info.minAndroidVersionCode || 1);
        const currentBuildNum = Number(currentBld || 1);

        const isVerOutdated = (cur, req) => {
          if (!req) return false;
          const cParts = String(cur).split(".").map((n) => parseInt(n, 10) || 0);
          const rParts = String(req).split(".").map((n) => parseInt(n, 10) || 0);
          for (let i = 0; i < Math.max(cParts.length, rParts.length); i++) {
            const c = cParts[i] || 0;
            const r = rParts[i] || 0;
            if (c < r) return true;
            if (c > r) return false;
          }
          return false;
        };

        const isOutdated = currentBuildNum < requiredBuild || isVerOutdated(currentVer, info.minAndroidVersion);

        const shouldEnforceUpdate = !__DEV__ && Platform.OS !== "web";
        if (shouldEnforceUpdate && info.forceUpdateEnabled && isOutdated) {
          setUpdateInfo(info);
          setUpdateRequired(true);
        } else {
          setUpdateRequired(false);
        }
      }
    } catch (e) {
      console.warn("[App] Version check error:", e?.message);
    }
  };

  const checkAllPermissions = async () => {
    try {
      setCheckingPermissions(true);

      // Check Foreground Permission
      const fgStatus = await Location.getForegroundPermissionsAsync();
      const bgStatus = await Location.getBackgroundPermissionsAsync().catch(() => ({ status: 'undetermined' }));

      if (Platform.OS === 'android') {
        // If foreground location is granted, allow user into the app.
        // Background permission is checked and guided during punch-in/out.
        if (fgStatus.status === "granted") {
          setPermissionsGranted(true);
          setCheckingPermissions(false);
          return true;
        }
        setPermissionsGranted(false);
        setCheckingPermissions(false);
        return false;
      }

      // Non-Android platforms
      if (fgStatus.status === "granted") {
        setPermissionsGranted(true);
        setCheckingPermissions(false);
        return true;
      }

      setPermissionsGranted(false);
      setCheckingPermissions(false);
      return false;
    } catch (e) {
      console.warn("[Permissions] Failed to check permissions:", e);
      setPermissionsGranted(false);
      setCheckingPermissions(false);
      return false;
    }
  };

  useEffect(() => {
    // Check for OTA updates immediately on app launch
    try {
      const { checkForAppUpdates } = require("./src/services/updateService");
      checkForAppUpdates(false);
    } catch (_) {}

    checkAppVersion();
    checkAllPermissions();

    // Listen for AppState changes to check permissions and re-check updates on app resume
    const subscription = AppState.addEventListener("change", (nextAppState) => {
      if (nextAppState === "active") {
        checkAllPermissions();
        checkAppVersion();
        try {
          const { checkForAppUpdates } = require("./src/services/updateService");
          checkForAppUpdates(false);
        } catch (_) {}
      }
    });

    // If running in emergency fallback or embedded launch, periodically check for new updates
    const pollInterval = setInterval(async () => {
      try {
        const Updates = require("expo-updates");
        if (Updates.isEmergencyLaunch || Updates.isEmbeddedLaunch) {
          const { checkForAppUpdates } = require("./src/services/updateService");
          await checkForAppUpdates(false);
        }
      } catch (_) {}
    }, 45000);

    return () => {
      clearInterval(pollInterval);
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    // Listen for notification taps while app is in foreground or background
    const cleanupNotifListener = setupNotificationResponseListener();

    // Check if app was opened by tapping a notification from killed state
    const timer = setTimeout(() => {
      checkInitialNotificationResponse();
    }, 1000);

    return () => {
      clearTimeout(timer);
      if (typeof cleanupNotifListener === 'function') {
        cleanupNotifListener();
      }
    };
  }, []);

  useEffect(() => {
    if (permissionsGranted) {
      // Check for OTA updates in the background (and prompt to reload if new version is downloaded)
      try {
        const { checkForAppUpdates } = require("./src/services/updateService");
        checkForAppUpdates(true);
      } catch (_) {}

      // Defer tracking init so UI tree mounts before any native module calls
      const timer = setTimeout(async () => {
        try {
          // Check if tracking is enabled for this user (set by admin via Mobile App Control)
          let trackingEnabled = true;
          try {
            const configStr = await AsyncStorage.getItem("@mobileAccessConfig");
            if (configStr) {
              const config = JSON.parse(configStr);
              if (config.trackingEnabled === false) {
                trackingEnabled = false;
              }
            }
          } catch (_) {}

          if (trackingEnabled) {
            const { initializeTracking } = require("./src/services/trackingManager");
            console.log("[App] Initializing tracking services...");
            initializeTracking();
          } else {
            console.log("[App] Tracking is disabled for this user by admin config. Skipping init.");
          }
        } catch (initErr) {
          console.warn("[App] Tracking init non-critical error:", initErr?.message);
        }
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [permissionsGranted]);

  return (
    <ErrorBoundary>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <SafeAreaProvider>
          {!permissionsGranted ? (
            <PreLoginPermissionScreen
              onPermissionsComplete={() => {
                setPermissionsGranted(true);
              }}
              onContinueAnyway={() => {
                setPermissionsGranted(true);
              }}
            />
          ) : (
            <SidebarProvider>
              <NavigationContainer ref={navigationRef}>
                <RootStack.Navigator
                  initialRouteName="Login"
                  screenOptions={{ headerShown: false }}
                >
                  <RootStack.Screen name="Login" component={LoginScreen} />
                  <RootStack.Screen name="Main" component={DashboardScreen} />
                  <RootStack.Screen name="Home" component={DashboardScreen} />
                  <RootStack.Screen
                    name="Attendance"
                    component={AttendanceScreen}
                  />
                  <RootStack.Screen
                    name="Shift"
                    component={ShiftManagementScreen}
                  />
                  <RootStack.Screen name="Leave" component={LeaveScreen} />
                  <RootStack.Screen name="Profile" component={ProfileScreen} />
                  <RootStack.Screen
                    name="MonthlyViewScreen"
                    component={MonthlyViewScreen}
                  />
                  <RootStack.Screen
                    name="CustomerVisitScreen"
                    component={CustomerVisitScreen}
                  />
                  <RootStack.Screen name="HRScreen" component={HRScreen} />
                  <RootStack.Screen
                    name="LeaveApprovals"
                    component={LeaveApprovalsScreen}
                  />
                  <RootStack.Screen
                    name="OrgChartScreen"
                    component={OrgChartScreen}
                  />

                  {/* Material Management Module */}
                  <RootStack.Screen
                    name="MaterialDashboard"
                    component={MaterialDashboardScreen}
                  />
                  <RootStack.Screen
                    name="MaterialRequestScreen"
                    component={MaterialRequestScreen}
                  />
                  <RootStack.Screen
                    name="MaterialListScreen"
                    component={MaterialListScreen}
                  />
                  <RootStack.Screen
                    name="MaterialDetailScreen"
                    component={MaterialDetailScreen}
                  />
                  <RootStack.Screen
                    name="BarcodeViewAllScreen"
                    component={BarcodeViewAllScreen}
                  />
                  <RootStack.Screen
                    name="BarcodeDetailScreen"
                    component={BarcodeDetailScreen}
                  />
                  <RootStack.Screen
                    name="TransferMaterialScreen"
                    component={TransferMaterialScreen}
                  />
                  <RootStack.Screen
                    name="ReturnMaterialScreen"
                    component={ReturnMaterialScreen}
                  />
                  <RootStack.Screen
                    name="SplitMaterialScreen"
                    component={SplitMaterialScreen}
                  />
                  <RootStack.Screen
                    name="ConvertMaterialScreen"
                    component={ConvertMaterialScreen}
                  />
                  <RootStack.Screen
                    name="StoreDispatchScreen"
                    component={StoreDispatchScreen}
                  />
                  <RootStack.Screen
                    name="ReceivingFormScreen"
                    component={ReceivingFormScreen}
                  />
                  <RootStack.Screen
                    name="ExchangeBarcodeScreen"
                    component={ExchangeBarcodeScreen}
                  />
                  <RootStack.Screen
                    name="MaterialsTreeScreen"
                    component={MaterialsTreeScreen}
                  />
                  <RootStack.Screen
                    name="TransferListScreen"
                    component={TransferListScreen}
                  />
                  <RootStack.Screen
                    name="ReturnListScreen"
                    component={ReturnListScreen}
                  />
                  <RootStack.Screen
                    name="PendingTransactionsScreen"
                    component={PendingTransactionsScreen}
                  />
                  <RootStack.Screen
                    name="MaterialMovementHub"
                    component={MaterialMovementHubScreen}
                  />
                  <RootStack.Screen
                    name="MergeMaterialScreen"
                    component={MergeMaterialScreen}
                  />
                  <RootStack.Screen
                    name="ReturnMultipleScreen"
                    component={ReturnMultipleScreen}
                  />
                  <RootStack.Screen
                    name="HandlerAssignmentScreen"
                    component={HandlerAssignmentScreen}
                  />

                  {/* Expense Management Module */}
                  <RootStack.Screen
                    name="ExpenseDashboard"
                    component={ExpenseDashboardScreen}
                  />
                  <RootStack.Screen
                    name="CreateExpenseClaim"
                    component={CreateExpenseClaimScreen}
                  />
                  <RootStack.Screen
                    name="ExpenseClaimDetail"
                    component={ExpenseClaimDetailScreen}
                  />
                  <RootStack.Screen
                    name="OtherApprovals"
                    component={OtherApprovalsScreen}
                  />

                  {/* Reports Module */}
                  <RootStack.Screen
                    name="Reports"
                    component={ReportsScreen}
                  />
                  <RootStack.Screen
                    name="ReportsScreen"
                    component={ReportsScreen}
                  />
                </RootStack.Navigator>
                {/* <SidebarDrawer /> */}
              </NavigationContainer>
            </SidebarProvider>
          )}
          <ForceUpdateModal
            visible={updateRequired}
            updateInfo={updateInfo}
            currentVersion={installedVersion}
            currentBuild={installedBuild}
          />
        </SafeAreaProvider>
      </GestureHandlerRootView>
    </ErrorBoundary>
  );
}

const styles = StyleSheet.create({
  lockContainer: {
    flex: 1,
    backgroundColor: "#ffffff",
    alignItems: "center",
    justifyContent: "center",
    padding: 30,
  },
  lockTitle: {
    fontSize: 26,
    fontWeight: "bold",
    color: "#1e293b",
    marginBottom: 10,
    textAlign: "center",
  },
  lockSubtitle: {
    fontSize: 18,
    fontWeight: "bold",
    color: "#4f46e5",
    marginBottom: 20,
    textAlign: "center",
  },
  lockDescription: {
    fontSize: 14,
    color: "#64748b",
    textAlign: "center",
    lineHeight: 22,
    marginBottom: 40,
  },
  lockButton: {
    backgroundColor: "#4f46e5",
    paddingHorizontal: 30,
    paddingVertical: 15,
    borderRadius: 25,
    shadowColor: "#4f46e5",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 6,
  },
  lockButtonText: {
    color: "#ffffff",
    fontSize: 16,
    fontWeight: "bold",
  },
});
