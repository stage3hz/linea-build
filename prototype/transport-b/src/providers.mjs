// Closed provider list for the experimental relay. Room links are bearer secrets.
const LINKS = {
  wbstream: /^wbstream:\/\/[A-Za-z0-9_-]{6,160}$/,
  telemost: /^https:\/\/telemost\.yandex\.ru\/j\/[0-9]{1,160}$/,
};

export function requireTransportProvider(provider = 'wbstream') {
  if (provider !== 'wbstream' && provider !== 'telemost') throw new TypeError('unsupported transport provider');
  return provider;
}

export function isProviderJoinLink(provider, joinLink) {
  requireTransportProvider(provider);
  if (typeof joinLink !== 'string') return false;
  // JavaScript's $ may match before a final newline; require the whole input.
  return LINKS[provider].exec(joinLink)?.[0] === joinLink;
}
