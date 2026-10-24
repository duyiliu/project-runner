#!/usr/bin/env python3
import json
import os
import select
import signal
import sys
import time


def emit(result, **extra):
    print(json.dumps({"result": result, **extra}, separators=(",", ":")))


def identity(pid):
    try:
        with open(f"/proc/{pid}/stat", encoding="ascii", errors="surrogateescape") as stat_file:
            raw = stat_file.read()
        fields = raw[raw.rfind(")") + 2:].split()
        if fields[0] in ("Z", "X", "x"):
            return {"result": "exited"}
        starttime = fields[19]
        try:
            image = os.readlink(f"/proc/{pid}/exe").removesuffix(" (deleted)")
        except OSError:
            image = f"comm:{raw[raw.find('(') + 1:raw.rfind(')')]}"
        with open("/proc/sys/kernel/random/boot_id", encoding="ascii") as boot_file:
            boot_id = boot_file.read().strip()
        return {"result": "ok", "creationFileTime": f"{boot_id}:{starttime}", "image": image}
    except FileNotFoundError:
        return {"result": "exited"}
    except OSError as error:
        return {"result": "error", "code": "identityFailed", "message": str(error)}


def process_state(pid):
    try:
        with open(f"/proc/{pid}/stat", encoding="ascii", errors="surrogateescape") as stat_file:
            raw = stat_file.read()
        fields = raw[raw.rfind(")") + 2:].split()
        return fields[0]
    except FileNotFoundError:
        return None
    except OSError:
        return "?"


def wait_stopped(pid, timeout_ms):
    deadline = time.monotonic() + timeout_ms / 1000
    while time.monotonic() < deadline:
        state = process_state(pid)
        if state is None or state in ("Z", "X", "x"):
            return "exited"
        if state in ("T", "t"):
            return "stopped"
        time.sleep(0.002)
    return "timeout"


def resume(pidfd):
    try:
        signal.pidfd_send_signal(pidfd, signal.SIGCONT)
    except (ProcessLookupError, OSError):
        pass


def main():
    if not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
        emit("error", code="pidfdUnsupported", message="Python 3.9+ and Linux pidfd support are required")
        return

    pid = int(sys.argv[1])
    expected_creation = sys.argv[2]
    expected_image = sys.argv[3]
    wait_ms = max(0, int(sys.argv[4]))
    # 可选第 5 参：信号名（默认 SIGKILL；--grace 用 SIGTERM 温和先行）
    try:
        sig = getattr(signal, sys.argv[5]) if len(sys.argv) > 5 else signal.SIGKILL
    except AttributeError:
        emit("error", code="badArgs", message=f"unknown signal {sys.argv[5]}")
        return
    # 可选第 7 参 freeze=1：先 SIGSTOP 冻结整个进程，再复核身份并发送信号。
    # Linux 的 /bin/sh wrapper 可能在核验后 exec 成目标；冻结后进程无法 exec，
    # 若身份已变则 SIGCONT 恢复并返回 mismatch，绝不向已 exec 的目标发终止信号。
    freeze = len(sys.argv) > 6 and sys.argv[6] == "1"
    try:
        pidfd = os.pidfd_open(pid, 0)
    except ProcessLookupError:
        emit("notfound")
        return
    except OSError as error:
        emit("error", code="pidfdOpenFailed", message=str(error))
        return

    try:
        frozen = False
        signal_sent = False
        current = identity(pid)
        if current["result"] != "ok":
            emit(current["result"], **{k: v for k, v in current.items() if k != "result"})
            return
        if current["creationFileTime"] != expected_creation:
            emit("mismatch", field="creationTime")
            return
        if current["image"] != expected_image:
            emit("mismatch", field="image")
            return
        if freeze:
            try:
                signal.pidfd_send_signal(pidfd, signal.SIGSTOP)
                frozen = True
            except ProcessLookupError:
                emit("exited")
                return
            except OSError as error:
                emit("error", code="freezeFailed", message=str(error))
                return
            frozen_state = wait_stopped(pid, 2000)
            if frozen_state == "exited":
                emit("exited")
                return
            if frozen_state != "stopped":
                emit("error", code="freezeTimeout", message="进程未在 2000ms 内停止，未发送终止信号")
                return
            # 冻结后进程无法 exec：此刻复核身份是稳定的。
            current = identity(pid)
            if current["result"] != "ok":
                emit(current["result"], **{k: v for k, v in current.items() if k != "result"})
                return
            field = None
            if current["creationFileTime"] != expected_creation:
                field = "creationTime"
            elif current["image"] != expected_image:
                field = "image"
            if field:
                emit("mismatch", field=field)
                return
        try:
            signal.pidfd_send_signal(pidfd, sig)
            signal_sent = True
        except ProcessLookupError:
            emit("exited")
            return
        except OSError as error:
            emit("error", code="terminateFailed", message=str(error))
            return

        poller = select.poll()
        poller.register(pidfd, select.POLLIN | select.POLLHUP | select.POLLERR)
        if poller.poll(wait_ms):
            emit("terminated")
        else:
            emit("terminateTimeout")
    finally:
        # 冻结后任何非成功终止路径（mismatch/异常/发信号失败）都必须 SIGCONT，
        # 避免 cleanup-wrapper 失败反而把目标或 wrapper 永久留在停止状态。
        if frozen and not signal_sent:
            resume(pidfd)
        os.close(pidfd)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, IndexError) as error:
        emit("error", code="badArgs", message=str(error))
    except Exception as error:
        # main() 的 finally 已在冻结后恢复 SIGCONT；这里保证任何未预期异常也返回可解析结果。
        emit("error", code="internalError", message=f"{type(error).__name__}: {error}")
