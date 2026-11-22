// The ring of ring.js ends as a missed call (tools/sim-seed-rich.mjs, SIM_SEED_SERVE).
const answer = http.get('http://127.0.0.1:3998/hangup');
output.hangup = answer.status;
