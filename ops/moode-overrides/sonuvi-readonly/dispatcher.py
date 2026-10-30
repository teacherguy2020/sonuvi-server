#!/usr/bin/python3
"""Forced-command dispatcher for the Sonuvi read-only moOde identity.

Every accepted command is a literal string. No caller input is used as a
filename, SQL expression, URL, subprocess argument, or shell fragment.
"""

import glob
import json
import os
import re
import socket
import sqlite3
import stat
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone


CONTRACT = "sonuvi.moode-readonly.v1"
DATABASE = "/var/local/www/db/moode-sqlite3.db"
AUDIOINFO_URL = "http://127.0.0.1/audioinfo.php"
MAX_AUDIOINFO_BYTES = 512 * 1024
MAX_PROC_FILE_BYTES = 32 * 1024
PATHS = {"musicLibraryRoot": "/var/lib/mpd/music", "moodeUsbMount": "/media/SamsungMoode"}
COMMANDS = {
    "sonuvi-readonly-v1 radio-catalog",
    "sonuvi-readonly-v1 diagnostics",
    "sonuvi-readonly-v1 audio-info-snapshot",
}


def utc_now():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def bounded_text(value, limit=4096):
    return str(value or "").replace("\x00", "").replace("\r", " ").replace("\n", " ").replace("\t", " ").strip()[:limit]


def read_text(path, limit=MAX_PROC_FILE_BYTES):
    with open(path, "r", encoding="utf-8", errors="replace") as handle:
        return handle.read(limit + 1)[:limit]


def read_lines(path):
    return [bounded_text(line, 1024) for line in read_text(path).splitlines()]


def readonly_db():
    db = sqlite3.connect("file:" + DATABASE + "?mode=ro", uri=True, timeout=3)
    db.execute("PRAGMA query_only=ON")
    db.enable_load_extension(False)
    return db


def catalog():
    # The URI, SQL and columns are literal. Neither stdin nor SSH arguments
    # can select a database, expression, extension, table, row or filename.
    with readonly_db() as db:
        columns = ["station", "name", "genre", "bitrate", "format", "type"]
        rows = db.execute("SELECT station,name,genre,bitrate,format,type FROM cfg_radio ORDER BY name,id").fetchmany(10001)
        if len(rows) > 10000:
            raise ValueError("catalog exceeds bounded response")
        stations = [{key: str(value or "") for key, value in zip(columns, row)} for row in rows]
        return {"stations": stations, "count": len(stations), "favoriteCount": sum(s["type"].lower() == "f" for s in stations)}


def diagnostics():
    paths = []
    for name, target in PATHS.items():
        try:
            status_value = "present" if stat.S_ISDIR(os.stat(target).st_mode) else "not-directory"
        except FileNotFoundError:
            status_value = "missing"
        except OSError:
            status_value = "unreadable"
        paths.append({"name": name, "path": target, "status": status_value})
    result = subprocess.run(
        ["/usr/bin/systemctl", "is-active", "mpd.service"],
        capture_output=True,
        text=True,
        timeout=3,
        env={"PATH": "/usr/bin:/bin", "LC_ALL": "C"},
    )
    return {"pathChecks": paths, "mpdService": "active" if result.returncode == 0 else "inactive", "readOnly": True}


def session_id():
    with readonly_db() as db:
        row = db.execute("SELECT value FROM cfg_system WHERE param='sessionid' LIMIT 1").fetchone()
    value = str(row[0] or "") if row else ""
    return value if re.fullmatch(r"[A-Za-z0-9,._-]{1,256}", value) else ""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def audio_info_html(current_session):
    request = urllib.request.Request(
        AUDIOINFO_URL,
        headers={"Cookie": "PHPSESSID=" + current_session},
        method="GET",
    )
    opener = urllib.request.build_opener(NoRedirect())
    try:
        with opener.open(request, timeout=4) as response:
            if response.status != 200:
                raise RuntimeError("unexpected audioinfo status")
            body = response.read(MAX_AUDIOINFO_BYTES + 1)
    except (urllib.error.URLError, urllib.error.HTTPError, OSError):
        raise RuntimeError("audioinfo unavailable")
    if len(body) > MAX_AUDIOINFO_BYTES:
        raise RuntimeError("audioinfo response too large")
    return body.decode("utf-8", errors="replace")


def redact_session_identifier(report, current_session):
    # `audioinfo.php` is expected to contain no session credential, but do not
    # make the collector's response depend on that implementation detail.
    return report.replace(current_session, "[redacted]") if current_session else report


def mpd_response(sock, command):
    stream = sock.makefile("rwb", buffering=0)
    greeting = stream.readline(256).decode("utf-8", errors="replace").strip()
    if not greeting.startswith("OK MPD"):
        raise RuntimeError("mpd greeting unavailable")
    stream.write((command + "\n").encode("ascii"))
    fields = {}
    for _ in range(512):
        line = stream.readline(8192).decode("utf-8", errors="replace").rstrip("\r\n")
        if line == "OK":
            return fields
        if line.startswith("ACK") or not line:
            raise RuntimeError("mpd response unavailable")
        if ": " in line:
            key, value = line.split(": ", 1)
            fields[key.lower()] = bounded_text(value, 4096)
    raise RuntimeError("mpd response exceeded bound")


def mpd_snapshot():
    with socket.create_connection(("127.0.0.1", 6600), timeout=3) as sock:
        status_fields = mpd_response(sock, "status")
    with socket.create_connection(("127.0.0.1", 6600), timeout=3) as sock:
        song_fields = mpd_response(sock, "currentsong")

    state = status_fields.get("state", "unknown").lower()
    if state not in {"play", "pause", "stop"}:
        state = "unknown"
    decoded = {"sampleRateHz": None, "bitDepth": None, "bitDepthKind": None, "channels": None}
    parts = status_fields.get("audio", "").split(":")
    if len(parts) == 3:
        try:
            decoded["sampleRateHz"] = int(parts[0]) if int(parts[0]) > 0 else None
            decoded["channels"] = int(parts[2]) if int(parts[2]) > 0 else None
        except ValueError:
            pass
        if parts[1] == "f":
            decoded["bitDepthKind"] = "float"
        else:
            try:
                bit_depth = int(parts[1])
                if bit_depth > 0:
                    decoded["bitDepth"] = bit_depth
                    decoded["bitDepthKind"] = "integer"
            except ValueError:
                pass
    return {
        "state": state,
        "source": bounded_text(song_fields.get("file"), 4096),
        "decoded": decoded,
    }


def status_value(lines):
    for line in lines:
        if line.lower().startswith("state:"):
            return bounded_text(line.split(":", 1)[1]).lower()
    return ""


def info_value(lines, name):
    prefix = name.lower() + ":"
    for line in lines:
        if line.lower().startswith(prefix):
            return bounded_text(line.split(":", 1)[1])
    return ""


def alsa_probe():
    lines = []
    for card_dir in sorted(glob.glob("/proc/asound/card*")):
        if not os.path.isdir(card_dir):
            continue
        card = os.path.basename(card_dir)
        card_id = bounded_text(read_text(os.path.join(card_dir, "id")), 256)
        lines.append("CARD\t%s\t%s" % (card, card_id))
        for pcm_dir in sorted(glob.glob(os.path.join(card_dir, "pcm*p"))):
            sub_dir = os.path.join(pcm_dir, "sub0")
            if not os.path.isdir(sub_dir):
                continue
            try:
                status_lines = read_lines(os.path.join(sub_dir, "status"))
            except OSError:
                continue
            state = status_value(status_lines)
            if not state or state == "closed":
                continue
            try:
                hw_lines = read_lines(os.path.join(sub_dir, "hw_params"))
            except OSError:
                hw_lines = []
            try:
                name = info_value(read_lines(os.path.join(pcm_dir, "info")), "name")
            except OSError:
                name = ""
            lines.append("PCM\t%s\t%s\t%s\t%s\t%s" % (pcm_dir, card, card_id, name, state))
            lines.extend("HW\t%s\t%s" % (pcm_dir, line) for line in hw_lines)
            lines.extend("STATUS\t%s\t%s" % (pcm_dir, line) for line in status_lines)
    return "\n".join(lines)


def unavailable(code):
    return {"status": "unavailable", "code": code}


def audio_info_snapshot():
    captured_at = utc_now()
    collection = {}
    try:
        mpd = mpd_snapshot()
        collection["mpd"] = {"status": "available"}
    except Exception:
        mpd = {"state": "unknown", "source": "", "decoded": {}}
        collection["mpd"] = unavailable("SONUVI_MPD_UNAVAILABLE")

    try:
        probe = alsa_probe()
        collection["alsa"] = {"status": "available"}
    except Exception:
        probe = ""
        collection["alsa"] = unavailable("SONUVI_ALSA_UNAVAILABLE")

    try:
        current_session = session_id()
    except Exception:
        current_session = ""
    if not current_session:
        collection["session"] = unavailable("SONUVI_MOODE_SESSION_UNAVAILABLE")
        collection["rendererReport"] = unavailable("SONUVI_MOODE_SESSION_UNAVAILABLE")
        report = ""
    else:
        collection["session"] = {"status": "available"}
        try:
            report = redact_session_identifier(audio_info_html(current_session), current_session)
            collection["rendererReport"] = {"status": "available"}
        except Exception:
            report = ""
            collection["rendererReport"] = unavailable("SONUVI_MOODE_REPORT_UNAVAILABLE")

    # The current PHP session identifier is deliberately never included in the
    # response, log output, error strings, or child-process arguments.
    return {
        "snapshot": {
            "capturedAt": captured_at,
            "audioInfoHtml": report,
            "alsaProbe": probe,
            "mpd": mpd,
            "collection": collection,
        }
    }


def main():
    command = os.environ.get("SSH_ORIGINAL_COMMAND", "")
    if len(sys.argv) != 1 or command not in COMMANDS:
        print(json.dumps({"ok": False, "code": "SONUVI_OPERATION_DENIED"}))
        return 126
    operation = command.split(" ", 1)[1]
    try:
        if operation == "radio-catalog":
            result = catalog()
        elif operation == "diagnostics":
            result = diagnostics()
        else:
            result = audio_info_snapshot()
        print(json.dumps({"contract": CONTRACT, "ok": True, "operation": operation, **result}, ensure_ascii=True))
        return 0
    except Exception:
        # Do not leak database internals, local paths, session identifiers, or
        # subprocess/network stderr through the forced-command response.
        print(json.dumps({"contract": CONTRACT, "ok": False, "code": "SONUVI_READ_UNAVAILABLE"}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
