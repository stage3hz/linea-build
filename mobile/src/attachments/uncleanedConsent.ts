// A video whose container the app cannot clean of metadata is never sent silently: the user is asked first,
// and «Отмена» is the default. The answer travels with the file (`sendUncleaned`), so a retry keeps it.
import { Alert, Platform } from 'react-native';
import { tr } from '../i18n';
import { needsUncleanedConsent, UNCLEANABLE_QUESTION, type UncleanedFile } from '../e2ee/attachments';
import type { LocalFile } from '../types';

function ask(): Promise<boolean> {
  if (Platform.OS === 'web') return Promise.resolve(typeof window !== 'undefined' && window.confirm(tr(UNCLEANABLE_QUESTION)));
  return new Promise(resolve => Alert.alert(tr(UNCLEANABLE_QUESTION), tr('Место съёмки, дата и модель устройства могут остаться в файле. Получатель увидит его как обычный файл.'), [
    { text: tr('Отмена'), style: 'cancel', onPress: () => resolve(false) },
    { text: tr('Отправить без очистки'), style: 'destructive', onPress: () => resolve(true) },
  ], { cancelable: true, onDismiss: () => resolve(false) }));
}

/** The file to send (marked as confirmed when it had to be), or null when the user declined. */
export async function withUncleanedConsent<T extends LocalFile>(file: T): Promise<T | null> {
  if (!(await needsUncleanedConsent(file))) return file;
  return (await ask()) ? { ...file, sendUncleaned: true } as T & UncleanedFile : null;
}
