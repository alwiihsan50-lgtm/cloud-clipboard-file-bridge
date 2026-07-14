from __future__ import annotations

import asyncio
import hashlib
import mimetypes
import os
import re
import socket
import sys
import threading
import time
from pathlib import Path
from typing import Any, Callable

import pyperclip
import requests
from dotenv import load_dotenv

try:
    from supabase import acreate_client
except Exception:  # pragma: no cover
    acreate_client = None

try:
    from winotify import Notification
except Exception:  # pragma: no cover
    Notification = None


load_dotenv(override=True)

BASE_URL = os.getenv("CLOUD_BRIDGE_BASE_URL", "http://127.0.0.1:8000").rstrip("/")
TOKEN = os.getenv("CLOUD_BRIDGE_TOKEN", "change-me")
DEVICE_ID = os.getenv("CLOUD_BRIDGE_DEVICE_ID") or f"windows-{socket.gethostname()}"
POLL_INTERVAL_MS = int(os.getenv("POLL_INTERVAL_MS", "5000"))
DOWNLOAD_DIR = Path(os.getenv("DOWNLOAD_DIR") or (Path.home() / "Downloads" / "CloudBridge"))

SUPABASE_URL = os.getenv("CLOUD_BRIDGE_SUPABASE_URL", "https://ajlkfzgpheegmwsnspxw.supabase.co").rstrip("/")
SUPABASE_PUBLISHABLE_KEY = os.getenv("CLOUD_BRIDGE_SUPABASE_PUBLISHABLE_KEY", "")
REALTIME_TOPIC = os.getenv("CLOUD_BRIDGE_REALTIME_TOPIC", "cloudbridge")
REALTIME_ENABLED = os.getenv("CLOUD_BRIDGE_REALTIME_ENABLED", "true").lower() in {"1", "true", "yes", "on"}
FALLBACK_POLL_INTERVAL_MS = int(os.getenv("CLOUD_BRIDGE_FALLBACK_POLL_INTERVAL_MS", "300000"))
LOCAL_CLIPBOARD_INTERVAL_MS = int(os.getenv("CLOUD_BRIDGE_LOCAL_CLIPBOARD_INTERVAL_MS", str(POLL_INTERVAL_MS)))
HEALTH_INTERVAL_MS = int(os.getenv("CLOUD_BRIDGE_HEALTH_INTERVAL_MS", "300000"))

HEADERS = {"Authorization": f"Bearer {TOKEN}"}
DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)


def text_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def log(message: str) -> None:
    print(f"[cloud-bridge] {message}", flush=True)


def notify(title: str, message: str) -> None:
    if Notification is None:
        log(f"{title}: {message}")
        return
    try:
        toast = Notification(app_id="Cloud Clipboard & File Bridge", title=title, msg=message)
        toast.show()
    except Exception:
        log(f"{title}: {message}")


def request_json(method: str, path: str, **kwargs: Any) -> dict[str, Any] | None:
    url = f"{BASE_URL}{path}"
    response = requests.request(method, url, headers=HEADERS, timeout=20, **kwargs)
    if response.status_code == 401:
        raise RuntimeError("Server rejected CLOUD_BRIDGE_TOKEN")
    response.raise_for_status()
    return response.json()


def broadcast_realtime(kind: str, payload: dict[str, Any]) -> None:
    if not realtime_available():
        return
    message = {
        "messages": [
            {
                "topic": REALTIME_TOPIC,
                "event": "cloudbridge_change",
                "payload": {"kind": kind, **payload},
            }
        ]
    }
    try:
        response = requests.post(
            f"{SUPABASE_URL}/realtime/v1/api/broadcast",
            headers={"apikey": SUPABASE_PUBLISHABLE_KEY, "Content-Type": "application/json"},
            json=message,
            timeout=10,
        )
        response.raise_for_status()
    except Exception as exc:
        log(f"Realtime broadcast failed: {exc}")


def health() -> dict[str, Any] | None:
    response = requests.get(f"{BASE_URL}/health", timeout=10)
    response.raise_for_status()
    return response.json()


def create_pairing(label: str = "Windows PC") -> dict[str, Any] | None:
    payload = {"device_id": DEVICE_ID, "label": label}
    return request_json("POST", "/api/pairing/create", json=payload)


def push_clipboard(content: str) -> dict[str, Any] | None:
    payload = {"content": content, "source": "windows", "device_id": DEVICE_ID}
    data = request_json("POST", "/api/clipboard/push", json=payload)
    item_data = (data or {}).get("item") or {}
    if item_data:
        broadcast_realtime(
            "clipboard",
            {
                "id": item_data.get("id"),
                "version": item_data.get("version"),
                "source": item_data.get("source"),
                "device_id": item_data.get("device_id"),
            },
        )
    return data


def pull_clipboard(since_id: str | None) -> dict[str, Any] | None:
    params = {"device_id": DEVICE_ID}
    if since_id:
        params["since_id"] = since_id
    return request_json("GET", "/api/clipboard/latest", params=params)


def upload_file(path: str | Path) -> dict[str, Any] | None:
    file_path = Path(path)
    if not file_path.is_file():
        raise FileNotFoundError(str(file_path))

    mime_type = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
    with file_path.open("rb") as file_handle:
        response = requests.post(
            f"{BASE_URL}/api/files/upload",
            headers=HEADERS,
            files={"file": (file_path.name, file_handle, mime_type)},
            data={"source": "windows-tray", "device_id": DEVICE_ID},
            timeout=300,
        )
    if response.status_code == 401:
        raise RuntimeError("Server rejected CLOUD_BRIDGE_TOKEN")
    response.raise_for_status()
    data = response.json()
    item_data = data.get("item") or {}
    if item_data:
        broadcast_realtime(
            "file",
            {
                "id": item_data.get("id"),
                "filename": item_data.get("filename"),
                "source": item_data.get("source"),
                "device_id": item_data.get("device_id"),
            },
        )
    return data


def sanitize_filename(filename: str) -> str:
    filename = Path(filename).name.strip()
    filename = re.sub(r'[<>:"/\\|?*\x00-\x1F]', "_", filename)
    return filename or "download.bin"


def unique_path(filename: str) -> Path:
    base = DOWNLOAD_DIR / sanitize_filename(filename)
    if not base.exists():
        return base

    stem = base.stem
    suffix = base.suffix
    for index in range(1, 1000):
        candidate = DOWNLOAD_DIR / f"{stem} ({index}){suffix}"
        if not candidate.exists():
            return candidate
    return DOWNLOAD_DIR / f"{stem}-{int(time.time())}{suffix}"


def download_file(file_item: dict[str, Any]) -> Path:
    file_id = file_item["id"]
    target = unique_path(file_item.get("filename") or "download.bin")
    url = f"{BASE_URL}/api/files/{file_id}/download"

    with requests.get(url, headers=HEADERS, stream=True, timeout=120) as response:
        response.raise_for_status()
        with target.open("wb") as out:
            for chunk in response.iter_content(chunk_size=1024 * 1024):
                if chunk:
                    out.write(chunk)

    request_json("POST", f"/api/files/{file_id}/ack")
    notify("CloudBridge file received", str(target))
    log(f"Downloaded {target}")
    return target


def poll_files() -> list[Path]:
    data = request_json("GET", "/api/files/pending", params={"device_id": DEVICE_ID})
    downloaded: list[Path] = []
    if not data:
        return downloaded
    for item_data in data.get("items", []):
        try:
            downloaded.append(download_file(item_data))
        except Exception as exc:
            log(f"File download failed for {item_data.get('filename')}: {exc}")
    return downloaded


class SyncState:
    def __init__(self) -> None:
        self.last_local_hash = ""
        self.last_seen_clipboard_id: str | None = None
        self.lock = threading.RLock()

    def check_local_clipboard(self) -> bool:
        with self.lock:
            local_text = pyperclip.paste()
            if not isinstance(local_text, str) or not local_text:
                return False

            local_hash = text_hash(local_text)
            if local_hash == self.last_local_hash:
                return False

            pushed = push_clipboard(local_text)
            item_data = (pushed or {}).get("item") or {}
            self.last_seen_clipboard_id = item_data.get("id") or self.last_seen_clipboard_id
            self.last_local_hash = local_hash
            log("Pushed Windows clipboard to cloud")
            return True

    def pull_remote_clipboard(self) -> bool:
        with self.lock:
            latest = pull_clipboard(self.last_seen_clipboard_id)
            if not latest or not latest.get("has_update") or not latest.get("item"):
                return False

            item_data = latest["item"]
            content = item_data["content"]
            pyperclip.copy(content)
            self.last_seen_clipboard_id = item_data["id"]
            self.last_local_hash = text_hash(content)
            notify("CloudBridge clipboard updated", "Text from cloud is ready to paste.")
            log(f"Pulled clipboard update from {item_data.get('source')}")
            return True

    def pull_remote_files(self) -> list[Path]:
        with self.lock:
            return poll_files()

    def sync_remote(self) -> list[Path]:
        with self.lock:
            self.pull_remote_clipboard()
            return self.pull_remote_files()

    def sync_once(self) -> list[Path]:
        with self.lock:
            self.check_local_clipboard()
            self.pull_remote_clipboard()
            return self.pull_remote_files()


def realtime_available() -> bool:
    return bool(REALTIME_ENABLED and SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY and acreate_client is not None)


async def realtime_listen(
    on_signal: Callable[[dict[str, Any]], None],
    stop_event: threading.Event | None = None,
    on_status: Callable[[str], None] | None = None,
) -> None:
    if not realtime_available():
        raise RuntimeError("Supabase Realtime is not configured")

    client = await acreate_client(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY)
    channel = client.channel(REALTIME_TOPIC)

    def message_received(payload: dict[str, Any]) -> None:
        on_signal(payload)

    await channel.on_broadcast("cloudbridge_change", message_received).subscribe()
    if on_status:
        on_status("subscribed")
    log(f"Realtime subscribed: {REALTIME_TOPIC}")

    try:
        while stop_event is None or not stop_event.is_set():
            await asyncio.sleep(1)
    finally:
        try:
            await channel.unsubscribe()
        except Exception:
            pass


def run_realtime_listener(
    state: SyncState,
    stop_event: threading.Event,
    on_status: Callable[[str], None] | None = None,
    on_files: Callable[[list[Path]], None] | None = None,
) -> None:
    def on_signal(payload: dict[str, Any]) -> None:
        signal = payload.get("payload") if isinstance(payload, dict) else None
        if not isinstance(signal, dict):
            signal = payload
        if signal.get("device_id") == DEVICE_ID:
            return

        try:
            kind = signal.get("kind")
            if kind == "clipboard":
                state.pull_remote_clipboard()
            elif kind == "file":
                files = state.pull_remote_files()
                if on_files:
                    on_files(files)
            else:
                files = state.sync_remote()
                if on_files:
                    on_files(files)
        except Exception as exc:
            log(f"Realtime signal handling failed: {exc}")

    while not stop_event.is_set():
        try:
            asyncio.run(realtime_listen(on_signal, stop_event, on_status))
        except Exception as exc:
            log(f"Realtime listener error: {exc}")
            if on_status:
                on_status(f"realtime error: {exc}")
            stop_event.wait(10)


def main() -> int:
    if not BASE_URL or not TOKEN:
        log("Set CLOUD_BRIDGE_BASE_URL and CLOUD_BRIDGE_TOKEN first.")
        return 2

    log(f"Agent started. device_id={DEVICE_ID}, server={BASE_URL}, downloads={DOWNLOAD_DIR}")

    state = SyncState()
    stop_event = threading.Event()
    last_fallback_at = 0.0
    last_health_at = 0.0
    local_interval = max(LOCAL_CLIPBOARD_INTERVAL_MS, 500) / 1000
    fallback_interval = max(FALLBACK_POLL_INTERVAL_MS, 30000) / 1000
    health_interval = max(HEALTH_INTERVAL_MS, 30000) / 1000

    if realtime_available():
        thread = threading.Thread(target=run_realtime_listener, args=(state, stop_event), daemon=True)
        thread.start()
    else:
        log("Realtime disabled or not configured; using fallback polling only.")

    while True:
        try:
            now_value = time.monotonic()
            state.check_local_clipboard()

            if now_value - last_health_at >= health_interval:
                health()
                last_health_at = now_value

            if now_value - last_fallback_at >= fallback_interval:
                state.sync_remote()
                last_fallback_at = now_value

        except KeyboardInterrupt:
            stop_event.set()
            log("Agent stopped.")
            return 0
        except Exception as exc:
            log(f"Loop error: {exc}")

        time.sleep(local_interval)


if __name__ == "__main__":
    sys.exit(main())
