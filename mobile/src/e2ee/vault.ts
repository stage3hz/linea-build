import type { PrivateVault } from './types';
export async function openVault(_server: string, _userId: string): Promise<PrivateVault> {
  throw new Error('Зашифрованное хранилище переписки доступно только в приложении Android или iPhone.');
}
