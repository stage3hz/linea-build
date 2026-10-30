// Center Stage (iPhone 17 family front camera follows the face). Native call is optional:
// Android and older builds simply report «not supported».
import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';
import type { LineaPhotoBridge } from '../../modules/linea-photo';

const native = requireOptionalNativeModule<LineaPhotoBridge>('LineaPhoto');
export async function setCenterStage(enabled: boolean): Promise<{ supported: boolean; enabled: boolean }> {
  if (Platform.OS !== 'ios' || !native?.setCenterStage) return { supported: false, enabled: false };
  try { return await native.setCenterStage(enabled); } catch { return { supported: false, enabled: false }; }
}
