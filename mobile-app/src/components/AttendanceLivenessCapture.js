import Constants from "expo-constants";
import * as Application from "expo-application";
import {
  ActivityIndicator,
  Linking,
  Modal,
  Platform,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useCallback, useEffect, useRef, useState } from "react";
import { RotateCcw, X } from "lucide-react-native";
import api from "../api/axios";

const isExpoGo =
  Constants.appOwnership === "expo" ||
  Constants.executionEnvironment === "storeClient";

const LIVENESS_STEPS = [
  "turn-left",
  "turn-right",
  "look-up",
  "look-down",
  "blink",
  "nod",
];

function createLocalChallengeSteps() {
  while (true) {
    const steps = [...LIVENESS_STEPS];
    for (let index = steps.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(Math.random() * (index + 1));
      [steps[index], steps[swapIndex]] = [steps[swapIndex], steps[index]];
    }
    const selected = steps.slice(0, 3 + Math.floor(Math.random() * 2));
    if (
      !selected.includes("nod") ||
      (!selected.includes("look-up") && !selected.includes("look-down"))
    ) {
      return selected;
    }
  }
}

function isValidServerChallenge(challenge) {
  return (
    typeof challenge?.nonce === "string" &&
    challenge.nonce.length >= 32 &&
    Array.isArray(challenge.steps) &&
    challenge.steps.length >= 3 &&
    challenge.steps.length <= 4 &&
    challenge.steps.every((step) => LIVENESS_STEPS.includes(step)) &&
    new Set(challenge.steps).size === challenge.steps.length &&
    !(
      challenge.steps.includes("nod") &&
      (challenge.steps.includes("look-up") || challenge.steps.includes("look-down"))
    )
  );
}

const FACE_REQUIREMENTS = {
  singleFace: true,
  centered: true,
  centerTolerance: 0.18,
  minFaceSize: 0.2,
  eyesOpen: true,
  minBrightness: 0.15,
  maxBrightness: 0.9,
};

const CAMERA_PERMISSION_ERROR = "Camera permission is required to verify attendance.";

const FAILURE_MESSAGES = {
  TIMEOUT: "The movement took too long. Follow each prompt and try again.",
  FACE_LOST: "Your face left the camera view. Keep your face visible and try again.",
  MULTIPLE_FACES: "More than one face was detected. Make sure only you are in view.",
  FACE_CHANGED: "The detected face changed. Please try the verification again.",
};

const QUALITY_MESSAGES = {
  NO_FACE: "Move your face into the camera view.",
  MULTIPLE_FACES: "Make sure only your face is visible.",
  FACE_TOO_SMALL: "Move a little closer to the camera.",
  FACE_TOO_LARGE: "Move a little farther from the camera.",
  FACE_NOT_CENTERED: "Center your face in the camera.",
  FACE_OUTSIDE_FRAME: "Keep your full face inside the camera view.",
  EYES_CLOSED: "Open your eyes and hold still.",
  TOO_DARK: "Move to a brighter place.",
  TOO_BRIGHT: "Move away from bright light.",
  TOO_BLURRY: "Hold the phone steady and clean the camera lens.",
};

function getQualityMessage(validation, guidance) {
  const blockingIssue = validation?.issues?.find(
    (issue) => issue.code !== "SIGNAL_UNAVAILABLE",
  );
  return (
    QUALITY_MESSAGES[blockingIssue?.code] ||
    (guidance?.status && QUALITY_MESSAGES[guidance.status]) ||
    "Hold your face steady in the camera."
  );
}

function ExpoGoBlockedScreen({ visible, onCancel }) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onCancel}
    >
      <View style={styles.permissionNotice}>
        <Text style={styles.guidanceTitle}>
          This build does not support secure attendance.
        </Text>
        <Text style={styles.guidanceSubtitle}>
          Please use the installed app or a development build.
        </Text>
        <TouchableOpacity
          accessibilityLabel="Close secure attendance message"
          onPress={onCancel}
          style={styles.retryButton}
        >
          <Text style={styles.retryButtonText}>Close</Text>
        </TouchableOpacity>
      </View>
    </Modal>
  );
}

function NativeLivenessCapture({ visible, purpose, onCancel, onCapture }) {
  const faceVision = require("@rbayuokt/expo-face-vision");
  const {
    FaceCamera,
    getCameraPermissionsAsync,
    requestCameraPermissionsAsync,
    useFaceCamera,
    useFaceValidation,
    useLivenessChallenge,
  } = faceVision;
  const camera = useFaceCamera();
  const [challenge, setChallenge] = useState(null);
  const [cameraGranted, setCameraGranted] = useState(false);
  const [challengeLoading, setChallengeLoading] = useState(false);
  const [error, setError] = useState("");
  const [capturing, setCapturing] = useState(false);
  const [passedSteps, setPassedSteps] = useState(null);
  const [livenessPassed, setLivenessPassed] = useState(false);
  const captureStarted = useRef(false);
  const qualityTimedOut = useRef(false);
  const qualityTimer = useRef(null);
  const isVisible = useRef(visible);
  isVisible.current = visible;

  const requirements = FACE_REQUIREMENTS;
  const { validation, guidance } = useFaceValidation(requirements, { camera });
  const validationRef = useRef(validation);
  const guidanceRef = useRef(guidance);
  validationRef.current = validation;
  guidanceRef.current = guidance;
  const handlePass = useCallback((state) => {
    setPassedSteps(state.completed.map((completedStep) => completedStep.step));
    setLivenessPassed(true);
    setError("");
  }, []);
  const handleFail = useCallback((reason) => {
    setError(FAILURE_MESSAGES[reason] || "Live verification failed. Please try again.");
  }, []);
  const liveness = useLivenessChallenge({
    camera,
    steps: challenge?.steps || [],
    randomize: false,
    voice: false,
    haptics: false,
    onPass: handlePass,
    onFail: handleFail,
  });

  const startChallenge = useCallback(async () => {
    setError("");
    setChallenge(null);
    setPassedSteps(null);
    setLivenessPassed(false);
    setCapturing(false);
    setCameraGranted(false);
    setChallengeLoading(true);
    captureStarted.current = false;
    qualityTimedOut.current = false;
    if (qualityTimer.current) clearTimeout(qualityTimer.current);

    try {
      let nextChallenge;
      try {
        const response = await api.post("/attendance/liveness/challenge", { purpose });
        const issuedChallenge = response.data?.data || response.data;
        if (!isValidServerChallenge(issuedChallenge)) {
          throw new Error("The server returned an invalid attendance challenge.");
        }
        nextChallenge = {
          nonce: issuedChallenge.nonce,
          steps: issuedChallenge.steps,
          serverIssued: true,
        };
      } catch (requestError) {
        if ([401, 403].includes(requestError.response?.status)) {
          throw requestError;
        }
        nextChallenge = {
          steps: createLocalChallengeSteps(),
          serverIssued: false,
        };
      }

      let permission = await getCameraPermissionsAsync();
      if (!permission.granted) {
        permission = await requestCameraPermissionsAsync();
      }
      if (!permission.granted) {
        setError(CAMERA_PERMISSION_ERROR);
        return;
      }
      if (!isVisible.current) return;

      setChallenge(nextChallenge);
      setCameraGranted(true);
    } catch (requestError) {
      console.warn(
        "[AttendanceLivenessCapture] Challenge request failed:",
        requestError?.message,
      );
      setError(
        requestError.message === "The server returned an invalid attendance challenge."
          ? requestError.message
          : requestError.response?.data?.message ||
            "Could not start attendance verification. Check your connection and retry.",
      );
    } finally {
      setChallengeLoading(false);
    }
  }, [getCameraPermissionsAsync, purpose, requestCameraPermissionsAsync]);

  useEffect(() => {
    if (visible) {
      startChallenge();
      return;
    }
    captureStarted.current = false;
    qualityTimedOut.current = false;
    if (qualityTimer.current) clearTimeout(qualityTimer.current);
    setChallenge(null);
    setCameraGranted(false);
    setChallengeLoading(false);
    setCapturing(false);
    setPassedSteps(null);
    setLivenessPassed(false);
    setError("");
    liveness.reset();
  }, [visible, startChallenge]);

  useEffect(() => {
    if (!visible || !challenge || !cameraGranted) return;
    liveness.reset();
    liveness.start();
  }, [cameraGranted, challenge, visible]);

  useEffect(() => {
    if (
      !visible ||
      !cameraGranted ||
      !challenge ||
      !livenessPassed ||
      error ||
      captureStarted.current ||
      qualityTimedOut.current
    ) {
      return;
    }

    const blockingIssues = validation?.issues?.filter(
      (issue) => issue.code !== "SIGNAL_UNAVAILABLE",
    );
    if (!validation || blockingIssues.length > 0) {
      if (!qualityTimer.current) {
        qualityTimer.current = setTimeout(() => {
          qualityTimedOut.current = true;
          const currentValidation = validationRef.current;
          const currentGuidance = guidanceRef.current;
          const blockingIssues =
            currentValidation?.issues?.filter(
              (issue) => issue.code !== "SIGNAL_UNAVAILABLE",
            ) || [];
          console.warn(
            "[AttendanceLivenessCapture] Capture quality timed out:",
            blockingIssues.map(({ code, value, expected }) => ({
              code,
              value,
              expected,
            })),
          );
          setError(getQualityMessage(currentValidation, currentGuidance));
        }, 8000);
      }
      return;
    }

    if (qualityTimer.current) clearTimeout(qualityTimer.current);
    qualityTimer.current = null;
    captureStarted.current = true;
    setCapturing(true);
    camera
      .takePhoto({ quality: 0.65 })
      .then((photo) => {
        if (!isVisible.current) return;
        if (!photo?.uri) {
          throw new Error("The camera did not return a photo.");
        }
        if (challenge.serverIssued) {
          onCapture(photo, {
            nonce: challenge.nonce,
            completedSteps: passedSteps,
            platform: Platform.OS,
            appVersion:
              Application.nativeApplicationVersion ||
              Constants.expoConfig?.version ||
              "unknown",
          });
        } else {
          onCapture(photo);
        }
      })
      .catch((captureError) => {
        console.warn(
          "[AttendanceLivenessCapture] Selfie capture error:",
          captureError?.message,
        );
        captureStarted.current = false;
        setError("Liveness passed, but the selfie could not be captured. Try again.");
      })
      .finally(() => setCapturing(false));
  }, [camera, challenge, error, guidance, livenessPassed, onCapture, passedSteps, validation, visible, cameraGranted]);

  const isFailed = liveness.phase === "failed";
  const canRetry = isFailed || Boolean(error);
  const detection =
    Platform.OS === "ios"
      ? { performanceMode: "fast", contours: true }
      : { performanceMode: "fast", classification: true };
  const waitingForQuality = livenessPassed && !capturing && !error;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={onCancel}
    >
      <StatusBar barStyle="light-content" backgroundColor="#0f172a" />
      <View style={styles.container}>
        <View style={styles.header}>
          <View>
            <Text style={styles.title}>
              {purpose === "punchOut" ? "Punch-out live check" : "Punch-in live check"}
            </Text>
            <Text style={styles.subtitle}>
              Follow the prompts to capture your selfie.
            </Text>
          </View>
          <TouchableOpacity
            accessibilityLabel="Cancel liveness verification"
            onPress={onCancel}
            style={styles.closeButton}
          >
            <X size={22} color="#ffffff" />
          </TouchableOpacity>
        </View>

        <View style={styles.cameraFrame}>
          {cameraGranted ? (
            <FaceCamera
              camera={camera}
              active={visible && !isFailed}
              inferenceFps={15}
              detection={detection}
              frameStats
              requirements={requirements}
              onCameraError={(cameraError) => {
                setError(cameraError?.message || "Could not start the camera.");
              }}
              style={styles.camera}
            >
              <View pointerEvents="none" style={styles.guidance}>
                <Text style={styles.guidanceTitle}>
                  {capturing
                    ? "Capturing selfie..."
                    : waitingForQuality
                      ? getQualityMessage(validation, guidance)
                      : error || liveness.text || "Center your face in the camera"}
                </Text>
                {!isFailed && !error && !capturing && challenge && (
                  <Text style={styles.guidanceSubtitle}>
                    Step {Math.min(liveness.stepIndex + 1, challenge.steps.length)} of{" "}
                    {challenge.steps.length}
                  </Text>
                )}
                {!isFailed && !error && !capturing && challenge?.serverIssued === false && (
                  <Text style={styles.guidanceSubtitle}>
                    Server unavailable; this is a local liveness check.
                  </Text>
                )}
              </View>
            </FaceCamera>
          ) : (
            <View style={styles.permissionNotice}>
              {(challengeLoading || (!error && !cameraGranted)) && (
                <ActivityIndicator color="#ffffff" />
              )}
              <Text style={styles.guidanceTitle}>
                {error || "Preparing attendance verification..."}
              </Text>
            </View>
          )}
        </View>

        {error === CAMERA_PERMISSION_ERROR && (
          <TouchableOpacity
            onPress={() => {
              Linking.openSettings().catch((settingsError) => {
                console.warn(
                  "[AttendanceLivenessCapture] Could not open settings:",
                  settingsError?.message,
                );
              });
            }}
            style={styles.retryButton}
            activeOpacity={0.85}
          >
            <Text style={styles.retryButtonText}>Open Settings</Text>
          </TouchableOpacity>
        )}

        <Text style={styles.disclaimer}>
          Your face is checked on this device. A selfie is captured after live
          verification and photo quality checks pass.
        </Text>

        {canRetry && (
          <TouchableOpacity
            onPress={startChallenge}
            style={styles.retryButton}
            activeOpacity={0.85}
          >
            <RotateCcw size={18} color="#ffffff" />
            <Text style={styles.retryButtonText}>Try liveness again</Text>
          </TouchableOpacity>
        )}
      </View>
    </Modal>
  );
}

export default function AttendanceLivenessCapture(props) {
  if (isExpoGo) {
    return <ExpoGoBlockedScreen {...props} />;
  }
  return <NativeLivenessCapture {...props} />;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0f172a",
    paddingHorizontal: 20,
    paddingTop: Platform.OS === "android" ? 42 : 58,
    paddingBottom: 28,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 20,
  },
  title: {
    color: "#ffffff",
    fontSize: 20,
    fontWeight: "800",
  },
  subtitle: {
    color: "#cbd5e1",
    fontSize: 13,
    marginTop: 5,
  },
  closeButton: {
    width: 42,
    height: 42,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#334155",
  },
  cameraFrame: {
    flex: 1,
    minHeight: 300,
    overflow: "hidden",
    borderRadius: 24,
    backgroundColor: "#1e293b",
  },
  camera: {
    flex: 1,
  },
  guidance: {
    position: "absolute",
    left: 16,
    right: 16,
    bottom: 24,
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderRadius: 16,
    backgroundColor: "rgba(15, 23, 42, 0.82)",
  },
  guidanceTitle: {
    color: "#ffffff",
    fontSize: 17,
    fontWeight: "700",
    textAlign: "center",
  },
  guidanceSubtitle: {
    color: "#cbd5e1",
    fontSize: 13,
    marginTop: 5,
  },
  permissionNotice: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    gap: 14,
    backgroundColor: "#0f172a",
  },
  disclaimer: {
    color: "#cbd5e1",
    fontSize: 12,
    lineHeight: 18,
    textAlign: "center",
    marginTop: 18,
  },
  retryButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: "#4f46e5",
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 18,
    marginTop: 16,
  },
  retryButtonText: {
    color: "#ffffff",
    fontSize: 15,
    fontWeight: "700",
  },
});
