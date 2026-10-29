import { requireOptionalNativeModule } from 'expo-modules-core';
import type { LineaPhotoBridge } from '../../modules/linea-photo';

const nativePhoto=requireOptionalNativeModule<LineaPhotoBridge>('LineaPhoto');
export function getPhotoBridge():LineaPhotoBridge {
  if(!nativePhoto)throw new Error('Нужна новая нативная сборка приложения с редактором фото.');
  return nativePhoto;
}
