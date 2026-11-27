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


class Model(BaseHTTPRequestHandler):
    def do_POST(self):
        data = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if self.headers.get("Authorization") != "Bearer terminal-fixture-token":
            self.send_response(401)
            self.end_headers()
            return
        last = data["messages"][-1]
        if last["role"] == "user":
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
        deadline = time.monotonic() + 15
        while expected not in self.output[self.mark:]:
            left = deadline - time.monotonic()
            if left <= 0 or not select.select([self.master], [], [], left)[0]:
                raise AssertionError((expected, bytes(self.output)))
            self.output.extend(os.read(self.master, 65536))
        self.mark = self.output.index(expected, self.mark) + len(expected)

    def close(self):
        if self.process.poll() is None:
            self.process.terminate()
            self.process.wait(timeout=5)
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
        assert setup.process.wait(timeout=5) == 0
    finally:
        setup.close()

    chat = Terminal(command + ["--write"], root, env)
    try:
        chat.expect(b"Type a request")
        chat.send(b"/settings\r")
        chat.expect(b"Change proposals")
        chat.send(b"/paste\r")
        chat.expect(b"/send submits")
        chat.send(b"read this file @source\t")
        chat.expect(b'@"source doc.txt"')
        chat.send(b"\rcreate two files\r/send\r")
        chat.expect(b"/diff to review")
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
        assert chat.process.wait(timeout=5) == 0
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
        resumed.send(b"/exit\r")
        assert resumed.process.wait(timeout=5) == 0
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
