import { desktopBridge } from '../desktop';
import type { PrivateVault } from './types';
export async function openVault(_server: string, _userId: string): Promise<PrivateVault> {
  const desktop = desktopBridge();
  if (desktop) { const id = await desktop.vault.open(`${_server}\0${_userId}`); return { get: key => desktop.vault.get(id,key), commit: values => desktop.vault.commit(id,values), close: () => desktop.vault.close(id) }; }
  throw new Error('Зашифрованное хранилище переписки доступно только в приложении Android или iPhone.');
}
