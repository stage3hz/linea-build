// Recipient tag for Mesh packets: a short hash of the recipient's account id, so a phone can
// tell «this one is for me» without opening anything. Not a secret: a relay that already knows
// someone's account id can recognise packets addressed to them (the content stays encrypted).
import { sha256 } from '@noble/hashes/sha2';
import { utf8ToBytes } from '@noble/hashes/utils';

export function recipientTag(userId: string): string {
  const digest = sha256(utf8ToBytes(`invizent-mesh-tag-v1|${userId}`)).slice(0, 16);
  let s = '';
  for (const b of digest) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
