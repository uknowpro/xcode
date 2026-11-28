"""End-to-end terminal smoke using a local fixture; requires a POSIX PTY."""
import fcntl
import json
import os
import pty
import select
import struct
import subprocess
import tempfile
import termios
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

WAIT_SECONDS = max(15, int(os.environ.get("XCODE_TEST_TIMEOUT_MS", "15000")) / 1000)


class Model(BaseHTTPRequestHandler):
    def do_POST(self):
        data = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if self.headers.get("Authorization") != "Bearer terminal-fixture-token":
            self.send_response(401)
            self.end_headers()
            return
        last = data["messages"][-1]
        if last["role"] == "user":
            content = last["content"]
            text = content if isinstance(content, str) else content[0]["text"]
            if "slow-input" in text:
                time.sleep(0.8)
                self.send_response(503)
                self.end_headers()
                return
            time.sleep(0.2)
            assert "read this file" in last["content"][0]["text"]
            assert "fixture source" in last["content"][1]["text"]
            args = {"changes": [
                {"path": "chosen.txt", "action": "create", "newText": "chosen\n"},
                {"path": "other.txt", "action": "create", "newText": "other\n"},
            ]}
            message = {"tool_calls": [{"id": "review", "type": "function", "function": {
                "name": "propose_changes", "arguments": json.dumps(args)}}]}
        else:
            assert json.loads(last["content"])["files"] == ["chosen.txt"]
            message = {"content": "Review applied"}
        payload = json.dumps({"choices": [{
            "message": message, "finish_reason": "tool_calls" if "tool_calls" in message else "stop",
        }]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *_):
        pass


class Terminal:
    def __init__(self, command, cwd, env):
        self.master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 105, 0, 0))
        try:
            self.process = subprocess.Popen(command, cwd=cwd, env=env, stdin=slave, stdout=slave, stderr=slave)
        finally:
            os.close(slave)
        self.output = bytearray()
        self.mark = 0

    def send(self, data):
        os.write(self.master, data)

    def expect(self, expected):
        deadline = time.monotonic() + WAIT_SECONDS
        while expected not in self.output[self.mark:]:
            left = deadline - time.monotonic()
            if left <= 0 or not select.select([self.master], [], [], left)[0]:
                raise AssertionError((expected, bytes(self.output)))
            self.output.extend(os.read(self.master, 65536))
        self.mark = self.output.index(expected, self.mark) + len(expected)

    def close(self):
        if self.process.poll() is None:
            self.process.terminate()
            self.process.wait(timeout=WAIT_SECONDS)
        os.close(self.master)


def smoke(scratch, endpoint):
    root = scratch / "workspace"
    root.mkdir()
    (root / "source doc.txt").write_text("fixture source", encoding="utf-8")
    env = {**os.environ, "XCODE_HOME": str(scratch / "state"), "TERM": "xterm-256color"}
    env.pop("XCODE_API_TOKEN", None)
    command = ["node", str(Path(__file__).resolve().parents[1] / "src/cli.mjs")]
    setup = Terminal(command + ["setup"], root, env)
    try:
        setup.expect(b"API URL")
        setup.send(endpoint.encode() + b"\r")
        setup.expect(b"Model ID")
        setup.send(b"fixture\r")
        setup.expect(b"API token")
        setup.send(b"terminal-fixture-token\r")
        setup.expect(b"Saved default profile")
        assert b"terminal-fixture-token" not in setup.output
        assert setup.process.wait(timeout=WAIT_SECONDS) == 0
    finally:
        setup.close()

    chat = Terminal(command + ["--write"], root, env)
    try:
        chat.expect(b"Type a request")
        chat.send(b"/set\t")
        chat.expect(b"/settings ")
        chat.send(b"\r")
        chat.expect(b"Change proposals")
        chat.send(b"\x1b[200~temporary config\r/cancel\rlast line\x1b[201~")
        chat.expect(b"3 lines")
        chat.send(b"/preview\r")
        chat.expect(b"3 lines in draft")
        chat.expect(b" 2  /cancel")
        chat.send(b"/cancel\r")
        chat.expect(b"Draft discarded")
        chat.send(b'/attach "source doc.txt"\r')
        chat.expect(b"For the next message")
        chat.send(b"/paste\r")
        chat.expect(b"/send submits")
        chat.send(b"read this file @source\t")
        chat.expect(b'@"source doc.txt"')
        chat.send(b"\rcreate two files")
        ready = time.monotonic() + WAIT_SECONDS
        while True:
            recovered = subprocess.run(command + ["draft", "latest"], cwd=root, env=env, capture_output=True, timeout=WAIT_SECONDS)
            if b"create two files" in recovered.stdout:
                assert b"source doc.txt" in recovered.stderr
                break
            if time.monotonic() >= ready:
                raise AssertionError("Typed draft was not checkpointed")
            time.sleep(0.05)
        chat.process.terminate()
        assert chat.process.wait(timeout=WAIT_SECONDS) == 0
        chat.close()
        chat = Terminal(command + ["resume", "latest"], root, env)
        chat.expect(b"Draft restored")
        chat.expect(b"create two files")
        chat.send(b"\r/send\r")
        chat.expect(b"Generating")
        chat.expect(b"/diff to review")
        chat.expect(b"Review pending \xc2\xb7 \xe2\x80\xba ")
        chat.send(b"/diff\r")
        chat.expect(b"Tab Files")
        chat.send(b"\t")
        chat.expect(b"Space Toggle")
        chat.send(b"\x1b[B ")
        chat.expect(b"[ ] other.txt")
        chat.send(b"\t")
        chat.expect(b"No verification results")
        chat.send(b"q")
        chat.expect(b"\x1b[?1049l")
        chat.send(b"/exit\r")
        assert chat.process.wait(timeout=WAIT_SECONDS) == 0
    finally:
        chat.close()

    resumed = Terminal(command + ["resume", "latest"], root, env)
    try:
        resumed.expect(b"Type a request")
        resumed.send(b"/apply\r")
        resumed.expect(b"Review applied")
        assert (root / "chosen.txt").read_text(encoding="utf-8") == "chosen\n"
        assert not (root / "other.txt").exists()
        resumed.send(b"/changes\r")
        resumed.expect(b"chosen.txt")
        resumed.expect(b"\x1b[0J\xe2\x80\xba ")
        resumed.send(b"/undo\r")
        resumed.expect(b"Undid change")
        assert not (root / "chosen.txt").exists()
        resumed.send(b"/new\r")
        resumed.expect(b"New session")
        resumed.send(b"/sessions\r")
        resumed.expect(b"Enter Switch")
        resumed.send(b"\x1b[B\r")
        resumed.expect(b"xcode \xc2\xb7 read this file")
        resumed.send(b"/sessions New session\r")
        resumed.expect(b"Sessions \xc2\xb7 1 \xc2\xb7 New session")
        resumed.expect(b"Enter Switch")
        resumed.send(b"\r")
        resumed.expect(b"xcode \xc2\xb7 New session")
        resumed.send(b"slow-input\r")
        resumed.expect(b"Generating")
        resumed.send(b"/paste\rkeep this draft\r")
        resumed.expect(b"1 line")
        resumed.send(b"\x03")
        resumed.expect(b"Stopping")
        resumed.send(b"/preview\r")
        resumed.expect(b" 1  keep this draft")
        resumed.send(b"/cancel\r/exit\r")
        assert resumed.process.wait(timeout=WAIT_SECONDS) == 0
    finally:
        resumed.close()


if __name__ == "__main__":
    with tempfile.TemporaryDirectory(prefix="xcode-terminal-") as folder, ThreadingHTTPServer(("127.0.0.1", 0), Model) as server:
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            smoke(Path(folder), f"http://127.0.0.1:{server.server_port}/v1")
        finally:
            server.shutdown()
    print("Terminal setup, attachment completion, review, restart and undo passed.")
