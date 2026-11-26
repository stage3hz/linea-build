#!/usr/bin/env python3
"""A picture of the simulator a few seconds after it is asked for.

The comparison workflow (.github/workflows/native-compare.yml) starts this on the runner:

    shot-server.py UDID FOLDER

and a flow asks for a picture before a touch whose result does not wait (a story plays for five seconds; what
Maestro does around a touch lasts longer): GET http://127.0.0.1:3997/shot?name=ref-44-own-story&after=3500 answers
at once and writes FOLDER/ref-44-own-story.png that many milliseconds later. Only the runner itself can ask, and
only for a comparison picture's name.
"""
import os
import re
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

UDID, FOLDER = sys.argv[1], sys.argv[2]
NAME = re.compile(r'(ref|nat)-[0-9]+-[a-z0-9-]+')


def take(name, after):
    time.sleep(after)
    path = os.path.join(FOLDER, name + '.png')
    for attempt in (1, 2):
        try:
            done = subprocess.run(['xcrun', 'simctl', 'io', UDID, 'screenshot', path],
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60)
            if done.returncode == 0:
                print('taken', name, flush=True)
                return
        except Exception as problem:  # a picture that could not be taken is only reported
            print('not taken', name, attempt, problem, flush=True)
    print('not taken', name, flush=True)


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        asked = urlparse(self.path)
        query = parse_qs(asked.query)
        name = query.get('name', [''])[0]
        try:
            after = min(30.0, max(0.0, float(query.get('after', ['0'])[0]) / 1000))
        except ValueError:
            after = 0.0
        if asked.path != '/shot' or not NAME.fullmatch(name):
            self.send_response(400)
            self.end_headers()
            return
        threading.Thread(target=take, args=(name, after), daemon=True).start()
        self.send_response(200)
        self.send_header('Content-Type', 'text/plain')
        self.end_headers()
        self.wfile.write(b'ok')

    def log_message(self, pattern, *values):
        print(pattern % values, flush=True)


HTTPServer(('127.0.0.1', 3997), Handler).serve_forever()
