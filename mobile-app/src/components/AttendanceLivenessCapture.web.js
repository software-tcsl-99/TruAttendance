import { Modal, Text, TouchableOpacity, View } from "react-native";

export default function AttendanceLivenessCapture({
  visible,
  onCancel,
}) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onCancel}
    >
      <View className="flex-1 bg-slate-950/90 items-center justify-center p-8">
        <View className="w-full max-w-sm rounded-3xl bg-white p-6 items-center">
          <Text className="text-lg font-extrabold text-slate-900 text-center">
            Liveness check needs the mobile app
          </Text>
          <Text className="text-sm text-slate-600 text-center mt-3">
            Live face verification is available in the Android or iOS app, not
            in the web version.
          </Text>
          <TouchableOpacity
            onPress={onCancel}
            className="mt-5 rounded-xl bg-indigo-600 px-6 py-3"
          >
            <Text className="font-bold text-white">Close</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}
