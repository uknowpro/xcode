"""Exercise the same draft and resize flow in each platform's real pseudoterminal."""
import os
import select
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

if os.name == "nt":
    from winpty import PtyProcess
else:
    import fcntl
    import pty
    import struct
    import termios


class Terminal:
    def __init__(self, argv, root, env):
        self.tail = ""
        if os.name == "nt":
            self.process = PtyProcess.spawn(argv, cwd=str(root), env=env, dimensions=(25, 100))
        else:
            self.master, slave = pty.openpty()
            try:
                fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 25, 100, 0, 0))
                self.process = subprocess.Popen(argv, cwd=root, env=env, stdin=slave, stdout=slave, stderr=slave)
            finally:
                os.close(slave)

    def send(self, value):
        if os.name == "nt":
            self.process.write(value)
        else:
            os.write(self.master, value.encode("utf-8"))

    def resize(self, rows, columns):
        if os.name == "nt":
            self.process.setwinsize(rows, columns)
        else:
            fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))

    def expect(self, text):
        when = time.monotonic() + 20
        while text not in self.tail:
            stream = self.process.fileobj if os.name == "nt" else self.master
            remaining = when - time.monotonic()
            if remaining <= 0 or not select.select([stream], [], [], remaining)[0]:
                raise AssertionError(f"Missing {text!r}; last terminal text {self.tail[-300:]!r}")
            chunk = self.process.read(2048) if os.name == "nt" else os.read(self.master, 4096).decode("utf-8", "replace")
            if not chunk:
                raise AssertionError(f"Terminal exited before displaying {text!r}")
            self.tail = (self.tail + chunk)[-32000:]
        self.tail = self.tail.split(text, 1)[1]

    def wait(self):
        if os.name == "nt":
            deadline = time.monotonic() + 20
            while self.process.isalive() and time.monotonic() < deadline:
                time.sleep(0.03)
            if self.process.isalive():
                raise AssertionError("Terminal did not exit after /exit")
        elif self.process.wait(timeout=20) != 0:
            raise AssertionError("Terminal exited with an error")

    def close(self):
        if os.name == "nt":
            self.process.close()
        else:
            if self.process.poll() is None:
                self.process.terminate()
                self.process.wait(timeout=10)
            os.close(self.master)


def main():
    cli = str(Path(__file__).resolve().parents[1] / "src" / "cli.mjs")
    with tempfile.TemporaryDirectory(prefix="xcode-platform-terminal-") as directory:
        root = Path(directory)
        state = root / "state"
        env = {**os.environ, "XCODE_HOME": str(state), "TERM": "xterm-256color"}
        command = [shutil.which("node"), cli]
        terminal = Terminal(command, root, env)
        try:
            terminal.expect("Type a request")
            terminal.send("/paste\r")
            terminal.expect("/send submits")
            terminal.send("first fixture row\rsecond fixture row\r")
            terminal.resize(20, 72)
            terminal.send("/preview\r")
            terminal.expect("2 lines in draft")
            terminal.send("/exit\r")
            terminal.wait()
        finally:
            terminal.close()
        resumed = Terminal(command + ["resume", "latest"], root, env)
        try:
            resumed.expect("Draft restored")
            resumed.send("/preview\r")
            resumed.expect("second fixture row")
            resumed.send("/exit\r")
            resumed.wait()
        finally:
            resumed.close()
    print("Terminal keyboard, window resize and draft resume passed.")


if __name__ == "__main__":
    main()
