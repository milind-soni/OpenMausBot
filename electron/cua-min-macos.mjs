// The pinned @trycua/cua-driver 0.45.4 SDK declares minos 13.0 but links
// ScreenCaptureKit strongly and names SCScreenshotManager (macOS 14) and
// SCRecordingOutput (macOS 15), so dyld cannot load it below 15.
export const CUA_MIN_MACOS = 15;
