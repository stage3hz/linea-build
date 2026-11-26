// Asks the runner for a picture of the simulator a few seconds from now (compare/shot-server.py on 127.0.0.1:3997,
// started by the workflow): NAME is the picture's name, AFTER the wait in milliseconds. The address is the runner's
// own; nothing else is spoken to. A runner that does not answer leaves the flow going (the pair then has no picture).
try {
  const answer = http.get('http://127.0.0.1:3997/shot?name=' + NAME + '&after=' + AFTER);
  output.shootLater = answer.status;
} catch (problem) {
  output.shootLater = 0;
}
