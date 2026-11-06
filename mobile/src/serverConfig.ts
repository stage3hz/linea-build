// INVIZENT always connects to its own server; the address cannot be changed in the app.
export const SERVER_URL = 'https://api.invizent.com';
// Earlier builds connected through this address. Encrypted local data (keys, history,
// Избранное, AI history) created there is reused so nothing is lost after the switch.
export const LEGACY_SERVER_URLS = ['https://141-133-194-51.nip.io'];
// Reserve entrance through Cloudflare (deploy/edge.sh): used only when no direct address
// answers — e.g. a VPN that cannot reach the server. Messages stay end-to-end encrypted.
export const EDGE_SERVER_URLS = ['https://invizent-api.invizent-8165e2.workers.dev'];

// Version this build reports to the server (header X-Linea-Client). The server
// may refuse clients it has retired (see server/src/clientgate.js). Bump this
// together with app.config.js version at every release.
export const APP_VERSION = '0.14.9';
