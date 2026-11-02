import {
  FaceCamera,
  getCameraPermissionsAsync,
  requestCameraPermissionsAsync,
  useFaceCamera,
  useLivenessChallenge,
} from "@rbayuokt/expo-face-vision";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Platform,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { RotateCcw, X } from "lucide-react-native";

const LIVENESS_STEPS = ["turn-left", "turn-right", "blink"];

export default function AttendanceLivenessCapture({
  visible,
  onCancel,
  onCapture,
}) {
  const camera = useFaceCamera();
  const liveness = useLivenessChallenge({
    camera,
    steps: LIVENESS_STEPS,
    randomize: true,
    voice: false,
    haptics: false,
  });
  const [cameraGranted, setCameraGranted] = useState(false);
  const [error, setError] = useState("");
  const [capturing, setCapturing] = useState(false);
  const captureStarted = useRef(false);
  const isVisible = useRef(visible);
  isVisible.current = visible;

  const startChallenge = async () => {
    setError("");
    setCapturing(false);
    captureStarted.current = false;

    try {
      let permission = await getCameraPermissionsAsync();
      if (!permission.granted) {
        permission = await requestCameraPermissionsAsync();
      }

      if (!permission.granted) {
        setCameraGranted(false);
        setError("Camera permission is required to verify attendance.");
        return;
      }

      if (!isVisible.current) return;
      setCameraGranted(true);
      liveness.reset();
      liveness.start();
    } catch (permissionError) {
      console.warn(
        "[AttendanceLivenessCapture] Camera permission error:",
        permissionError?.message,
      );
      setError("Could not access the camera. Please try again.");
    }
  };

  useEffect(() => {
    if (visible) {
      startChallenge();
    } else {
      captureStarted.current = false;
      setCameraGranted(false);
      setCapturing(false);
      setError("");
      liveness.reset();
    }
  }, [visible]);

  useEffect(() => {
    if (liveness.phase !== "passed" || captureStarted.current) return;

    captureStarted.current = true;
    setCapturing(true);
    camera
      .takePhoto({ quality: 0.65 })
      .then((photo) => {
        if (!isVisible.current) return;
        if (!photo?.uri) {
          throw new Error("The camera did not return a photo.");
        }
        onCapture(photo);
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
  }, [liveness.phase, camera, onCapture]);

  const isFailed = liveness.phase === "failed";
  const canRetry = isFailed || Boolean(error);
  const detection =
    Platform.OS === "ios"
      ? { performanceMode: "fast", contours: true }
      : { performanceMode: "fast", classification: true };

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
            <Text style={styles.title}>Live attendance check</Text>
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
              inferenceFps={20}
              detection={detection}
              onCameraError={(cameraError) => {
                setError(cameraError?.message || "Could not start the camera.");
              }}
              style={styles.camera}
            >
              <View pointerEvents="none" style={styles.guidance}>
                <Text style={styles.guidanceTitle}>
                  {capturing
                    ? "Capturing selfie..."
                    : liveness.phase === "passed"
                      ? "Liveness verified"
                      : isFailed
                        ? "Verification failed"
                        : liveness.text || "Center your face in the camera"}
                </Text>
                {!isFailed && !error && !capturing && (
                  <Text style={styles.guidanceSubtitle}>
                    Step {Math.min(liveness.stepIndex + 1, liveness.steps.length)} of{" "}
                    {liveness.steps.length}
                  </Text>
                )}
              </View>
            </FaceCamera>
          ) : (
            <View style={styles.permissionNotice}>
              <Text style={styles.guidanceTitle}>
                {error || "Preparing camera..."}
              </Text>
              {!error && <ActivityIndicator color="#ffffff" />}
            </View>
          )}
        </View>

        <Text style={styles.disclaimer}>
          Your face is checked on this device. A selfie is captured after all
          liveness steps pass.
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
    marginTop: 16,
  },
  retryButtonText: {
    color: "#ffffff",
    fontSize: 15,
    fontWeight: "700",
  },
});
