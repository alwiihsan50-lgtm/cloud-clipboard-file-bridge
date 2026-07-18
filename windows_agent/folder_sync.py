from __future__ import annotations

import os
import subprocess
import threading
import time
from pathlib import Path
from typing import Callable

try:
    from watchdog.events import FileSystemEvent, FileSystemEventHandler
    from watchdog.observers import Observer
except Exception:  # pragma: no cover - optional until requirements are installed
    FileSystemEvent = object  # type: ignore[assignment,misc]
    FileSystemEventHandler = object  # type: ignore[assignment,misc]
    Observer = None


LogCallback = Callable[[str], None]


class _ChangeHandler(FileSystemEventHandler):
    def __init__(self, coordinator: "FolderSyncCoordinator") -> None:
        super().__init__()
        self.coordinator = coordinator

    def on_any_event(self, event: FileSystemEvent) -> None:
        event_type = getattr(event, "event_type", "")
        if event_type not in {"created", "modified", "deleted", "moved"}:
            return
        self.coordinator.trigger_local()


class FolderSyncCoordinator:
    def __init__(
        self,
        local_path: Path,
        sync_script: Path,
        device_id: str,
        log: LogCallback,
        debounce_seconds: float = 3.0,
        stable_seconds: float = 1.5,
    ) -> None:
        self.local_path = local_path
        self.sync_script = sync_script
        self.device_id = device_id
        self.log = log
        self.debounce_seconds = max(1.0, debounce_seconds)
        self.stable_seconds = max(0.5, stable_seconds)
        self._condition = threading.Condition()
        self._pending = False
        self._local_pending = False
        self._due_at = 0.0
        self._running = False
        self._ignore_local_until = 0.0
        self._stop_event = threading.Event()
        self._worker: threading.Thread | None = None
        self._observer: Observer | None = None

    @property
    def available(self) -> bool:
        return self.sync_script.is_file()

    def start(self) -> bool:
        if not self.available:
            self.log(f"Folder sync script not found: {self.sync_script}")
            return False

        self.local_path.mkdir(parents=True, exist_ok=True)
        self._worker = threading.Thread(
            target=self._worker_loop,
            name="cloudbridge-folder-sync",
            daemon=True,
        )
        self._worker.start()

        if Observer is None:
            self.log("watchdog is unavailable; Realtime folder triggers remain active")
            return True

        self._observer = Observer()
        self._observer.schedule(_ChangeHandler(self), str(self.local_path), recursive=True)
        self._observer.start()
        self.log(f"Watching folder changes: {self.local_path}")
        return True

    def stop(self) -> None:
        self._stop_event.set()
        with self._condition:
            self._condition.notify_all()
        if self._observer is not None:
            self._observer.stop()
            self._observer.join(timeout=5)
        if self._worker is not None:
            self._worker.join(timeout=5)

    def trigger_local(self) -> None:
        with self._condition:
            if self._running or time.monotonic() < self._ignore_local_until:
                return
            self._pending = True
            self._local_pending = True
            self._due_at = time.monotonic() + self.debounce_seconds
            self._condition.notify()

    def trigger_remote(self) -> None:
        with self._condition:
            if self._running:
                self._pending = True
                self._due_at = time.monotonic() + 0.5
                self._condition.notify()
                return
            now = time.monotonic()
            self._pending = True
            if not self._local_pending:
                remote_due = now + 0.5
                self._due_at = min(self._due_at, remote_due) if self._due_at > now else remote_due
            self._condition.notify()

    def _snapshot(self) -> tuple[tuple[str, int, int], ...]:
        result: list[tuple[str, int, int]] = []
        for path in self.local_path.rglob("*"):
            try:
                if path.is_file():
                    stat = path.stat()
                    result.append((str(path.relative_to(self.local_path)), stat.st_size, stat.st_mtime_ns))
            except OSError:
                continue
        return tuple(sorted(result))

    def _wait_until_stable(self) -> bool:
        deadline = time.monotonic() + 30.0
        previous = self._snapshot()
        while not self._stop_event.wait(self.stable_seconds):
            current = self._snapshot()
            if current == previous:
                return True
            previous = current
            if time.monotonic() >= deadline:
                self.log("Folder remained busy; postponing sync")
                return False
        return False

    def _run_sync(self) -> None:
        command = [
            "powershell.exe",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(self.sync_script),
            "-LocalPath",
            str(self.local_path),
            "-DeviceId",
            self.device_id,
        ]
        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=600,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            check=False,
        )
        if completed.returncode != 0:
            detail = (completed.stderr or completed.stdout or "unknown error").strip()
            raise RuntimeError(f"folder sync exited {completed.returncode}: {detail[-500:]}")
        self.log("Folder sync completed")

    def _worker_loop(self) -> None:
        while not self._stop_event.is_set():
            with self._condition:
                while not self._pending and not self._stop_event.is_set():
                    self._condition.wait(timeout=1)
                if self._stop_event.is_set():
                    return
                remaining = self._due_at - time.monotonic()
                if remaining > 0:
                    self._condition.wait(timeout=remaining)
                    continue
                local_pending = self._local_pending
                self._pending = False
                self._local_pending = False
                self._running = True

            retry_local = False
            try:
                if local_pending and not self._wait_until_stable():
                    retry_local = True
                    continue
                self._run_sync()
            except Exception as exc:
                self.log(f"Folder sync failed: {exc}")
            finally:
                with self._condition:
                    self._running = False
                    self._ignore_local_until = time.monotonic() + 3.0
                    if retry_local:
                        self._ignore_local_until = 0.0
                        self._pending = True
                        self._local_pending = True
                        self._due_at = time.monotonic() + self.debounce_seconds
                        self._condition.notify()


def default_sync_script() -> Path:
    configured = os.getenv("CLOUD_BRIDGE_FOLDER_SYNC_SCRIPT")
    if configured:
        return Path(configured)
    return Path(os.getenv("LOCALAPPDATA", str(Path.home()))) / "CloudBridge" / "Sync" / "sync-cloudbridge.ps1"
