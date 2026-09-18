"""Real-terminal checks; called by agentsession.test.ts with isolated SDKs/storage."""
import fcntl
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import time

master, slave = pty.openpty()
original = termios.tcgetattr(slave)
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 90, 0, 0))
child = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave,
                         env={**os.environ, "TERM": "xterm-256color"})
output = b""


def expect(text):
    global output
    marker = text.encode()
    deadline = time.monotonic() + 4
    while marker not in output:
        assert time.monotonic() < deadline, (text, output[-3000:])
        if select.select([master], [], [], 0.05)[0]:
            output += os.read(master, 65536)


def send(text):
    global output
    output = b""
    os.write(master, text.encode())


try:
    expect("\x1b[?1049h")  # RED: existing chat has no fullscreen UI.
    expect("agentsession")
    expect("you>")
    send("@missing hello\r")
    expect("unknown agent: missing")
    send("@claude TEST_SUCCESS 한글 👩‍💻\r")
    expect("done")
    send("@codex TEST_FAILURE\r")
    expect("test SDK failure")
    send("@codex hello\r")
    expect("생각 중")
    send("작성 중인 문장")
    expect("작성 중인 문장")
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 12, 40, 0, 0))
    child.send_signal(signal.SIGWINCH)
    expect("you>")
    send("\x15/quit\r")  # Ctrl+U clears the draft; quit must work during a turn.
    expect("\x1b[?1049l")
    assert child.wait(timeout=4) == 0
    restored = termios.tcgetattr(slave)
    assert restored[3] & (termios.ECHO | termios.ICANON) == original[3] & (termios.ECHO | termios.ICANON)
    print("TUI PTY checks passed (routing, Unicode, errors, resize, busy quit, terminal restore)")
finally:
    if child.poll() is None:
        child.kill()
        child.wait()
    os.close(master)
    os.close(slave)
