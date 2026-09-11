"""Exercise a real controlling terminal using only Python's POSIX standard library."""
import os, pty, select, signal, sys, time

mode = sys.argv[1]
pid, fd = pty.fork()
if pid == 0:
    os.execv(sys.argv[2], sys.argv[2:])
output = b""
approved = submitted = False
deadline = time.monotonic() + 25
try:
    while time.monotonic() < deadline:
        ready, _, _ = select.select([fd], [], [], 0.1)
        if not ready:
            continue
        try:
            chunk = os.read(fd, 8192)
        except OSError:
            break
        if not chunk:
            break
        output += chunk
        if b"Approve fixture tool?" in output and not approved and mode != "timeout":
            os.write(fd, b"y\n")
            approved = True
        if b"Gemini exited. Paste" in output and not submitted:
            os.write(fd, b".pause\n" if mode == "pause" else b'{"summary":"fixture result"}\n.end\n')
            submitted = True
        if len(output) > 1000000:
            raise RuntimeError("Unexpected excessive terminal output")
    else:
        raise RuntimeError("Terminal fixture timed out")
finally:
    os.close(fd)
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    os.waitpid(pid, 0)
sys.stdout.write(output.decode(errors="replace"))
