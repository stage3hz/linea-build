// INVIZENT always connects to its own server; the address cannot be changed in the app.
export const SERVER_URL = 'https://api.invizent.com';
// Earlier builds connected through this address. Encrypted local data (keys, history,
// Избранное, AI history) created there is reused so nothing is lost after the switch.
export const LEGACY_SERVER_URLS = ['https://141-133-194-51.nip.io'];
