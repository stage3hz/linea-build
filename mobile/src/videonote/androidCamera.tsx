// Android round-video camera (CameraX persistent recording, see VideoNoteCamera.kt): the camera
// can be switched while recording. Absent on iOS, web and older builds — the caller falls back.
import React, { forwardRef } from 'react';
import { Platform, type ViewStyle, type StyleProp } from 'react-native';
import { requireNativeViewManager, requireOptionalNativeModule } from 'expo-modules-core';

export type AndroidNoteCameraHandle = { startRecording: (path: string) => Promise<void>; stopRecording: () => Promise<string> };
type Props = { facing: 'front' | 'back'; style?: StyleProp<ViewStyle>; onReady?: () => void; onCameraError?: (event: { nativeEvent: { message?: string } }) => void };

const available = Platform.OS === 'android' && !!requireOptionalNativeModule('LineaVideoNote');
const NativeView: React.ComponentType<Props & { ref?: React.Ref<AndroidNoteCameraHandle> }> | null = available ? requireNativeViewManager('LineaVideoNote') : null;

export const androidNoteCameraAvailable = !!NativeView;
export const AndroidNoteCamera = forwardRef<AndroidNoteCameraHandle, Props>((props, ref) => NativeView ? <NativeView ref={ref} {...props} /> : null);
