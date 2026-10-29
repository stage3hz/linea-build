import {requireOptionalNativeModule} from 'expo-modules-core';
import type {LineaVideoBridge} from '../../modules/linea-video';
const nativeVideo=requireOptionalNativeModule<LineaVideoBridge>('LineaVideo');
export function getVideoBridge():LineaVideoBridge {
  if(!nativeVideo)throw new Error('Нужна актуальная нативная сборка с обработкой видео.');
  return nativeVideo;
}
