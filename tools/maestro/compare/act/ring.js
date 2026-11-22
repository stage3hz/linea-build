// Анна calls the account: the seeding process (tools/sim-seed-rich.mjs, SIM_SEED_SERVE) sends a call offer on request.
// The address is the runner's own (the simulator shares its network); nothing else is spoken to.
const answer = http.get('http://127.0.0.1:3998/ring');
output.ring = answer.status;
