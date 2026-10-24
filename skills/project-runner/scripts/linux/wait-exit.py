#!/usr/bin/env python3
# Wait for a Linux process instance to exit and report its real status (#102).
# argv: <pid> <bootId:starttime>. The pidfd anchors the process instance; creation
# time is verified before waiting so a reused PID can never be attributed here.
import json
import os
import select
import signal
import sys
import time

PROC = "/proc"


def emit(obj):
    print(json.dumps(obj, separators=(",", ":")))
    sys.exit(0)


def boot_id():
    try:
        with open(os.path.join(PROC, "sys/kernel/random/boot_id"), encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return "boot-unknown"


def read_stat(pid):
    try:
        with open(os.path.join(PROC, str(pid), "stat"), encoding="utf-8") as f:
            raw = f.read()
    except OSError:
        return None
    close = raw.rfind(")")
    if close < 0:
        return None
    fields = raw[close + 2:].strip().split()
    if len(fields) < 50:
        return None
    # fields[0]=state, fields[1]=ppid, fields[19]=starttime, fields[49]=exit_code
    return {"state": fields[0], "starttime": fields[19], "exit_code": fields[49]}


def status_from_exit_code(exit_code):
    code = (exit_code >> 8) & 0xFF
    sig = exit_code & 0x7F
    if sig:
        try:
            return {"result": "exited", "code": None, "signal": signal.Signals(sig).name}
        except ValueError:
            return {"result": "exited", "code": None, "signal": f"SIG{sig}"}
    return {"result": "exited", "code": code, "signal": None}


def main():
    if len(sys.argv) < 3:
        emit({"result": "error", "code": "badArgs"})
    try:
        pid = int(sys.argv[1])
    except ValueError:
        emit({"result": "error", "code": "badArgs"})
    expected = sys.argv[2]
    parts = expected.split(":")
    if len(parts) != 2:
        emit({"result": "error", "code": "badArgs"})

    before = read_stat(pid)
    if not before:
        emit({"result": "notfound"})
    if before["starttime"] != parts[1] or boot_id() != parts[0]:
        emit({"result": "mismatch", "field": "creationTime"})

    try:
        fd = os.pidfd_open(pid)
    except ProcessLookupError:
        emit({"result": "notfound"})
    except OSError as e:
        emit({"result": "error", "code": getattr(e, "errno", "pidfdOpenFailed")})

    # pidfd 打开后必须再核验一次身份：首次 /proc 检查与 pidfd_open 之间目标可能
    # 已退出且 PID 被复用。pidfd 若绑定到新进程，这里 starttime 不一致会拒绝；
    # 若绑定到旧进程，后续等待/退出码都属于正确实例。
    after_open = read_stat(pid)
    if not after_open:
        emit({"result": "notfound"})
    if after_open["starttime"] != parts[1] or boot_id() != parts[0]:
        emit({"result": "mismatch", "field": "creationTime"})

    if len(sys.argv) >= 4 and sys.argv[3]:
        try:
            with open(sys.argv[3], "w", encoding="utf-8") as f:
                f.write("ready")
        except OSError:
            pass

    poller = select.poll()
    poller.register(fd, select.POLLIN)
    poller.poll()

    # Prefer waitid(P_PIDFD, WNOWAIT): where supported it returns the exit status
    # without reaping. Non-child targets may return ECHILD; fall back to the
    # zombie's /proc exit_code while the parent has not reaped it yet.
    if hasattr(os, "P_PIDFD") and hasattr(os, "WNOWAIT"):
        try:
            info = os.waitid(os.P_PIDFD, fd, os.WEXITED | os.WNOWAIT)
        except (ChildProcessError, OSError):
            info = None
        if info is not None:
            if info.si_code in (os.CLD_EXITED,):
                emit({"result": "exited", "code": info.si_status, "signal": None})
            if hasattr(os, "CLD_KILLED") and info.si_code in (os.CLD_KILLED, getattr(os, "CLD_DUMPED", -1)):
                try:
                    sig = signal.Signals(info.si_status).name
                except ValueError:
                    sig = f"SIG{info.si_status}"
                emit({"result": "exited", "code": None, "signal": sig})

    for _ in range(100):
        current = read_stat(pid)
        if current and current["state"] in ("Z", "X", "x"):
            try:
                emit(status_from_exit_code(int(current["exit_code"], 10)))
            except ValueError:
                pass
        elif current is None:
            break
        time.sleep(0.001)
    # 父进程可能已在 pidfd 事件后立即回收目标（waitid 对非子进程返回 ECHILD）；
    # 此时不能伪造 code/signal，明确报告不可用，由 watcher 留下可诊断证据。
    emit({"result": "unavailable", "reason": "target reaped before exit status was readable"})


if __name__ == "__main__":
    main()
