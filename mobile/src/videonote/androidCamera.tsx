// Round-video camera that keeps recording while the camera is switched: Android — CameraX persistent
// recording (VideoNoteCamera.kt), iPhone — AVCaptureSession + AVAssetWriter (VideoNoteCamera.swift).
// Absent on web and older builds — the caller falls back to expo-camera.
import React, { forwardRef } from 'react';
import { Platform, type ViewStyle, type StyleProp } from 'react-native';
import { requireNativeViewManager, requireOptionalNativeModule } from 'expo-modules-core';

export type AndroidNoteCameraHandle = { startRecording: (path: string) => Promise<void>; stopRecording: () => Promise<string>; pauseRecording?: (paused: boolean) => Promise<void> };
type Props = { facing: 'front' | 'back'; torch?: boolean; zoom?: number; style?: StyleProp<ViewStyle>; onReady?: () => void; onCameraError?: (event: { nativeEvent: { message?: string } }) => void };

const available = (Platform.OS === 'android' || Platform.OS === 'ios') && !!requireOptionalNativeModule('LineaVideoNote');
const NativeView: React.ComponentType<Props & { ref?: React.Ref<AndroidNoteCameraHandle> }> | null = available ? requireNativeViewManager('LineaVideoNote') : null;

export const androidNoteCameraAvailable = !!NativeView;
const nativeModule = available ? requireOptionalNativeModule<{ prewarm?: () => void }>('LineaVideoNote') : null;
/** Android: initialises CameraX ahead of the first press (no-op where the native side has no `prewarm`). */
export function prewarmNoteCamera() { try { nativeModule?.prewarm?.(); } catch { /* optional */ } }
export const AndroidNoteCamera = forwardRef<AndroidNoteCameraHandle, Props>((props, ref) => NativeView ? <NativeView ref={ref} {...props} /> : null);
