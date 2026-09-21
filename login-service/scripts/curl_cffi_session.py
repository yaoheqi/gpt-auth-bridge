from __future__ import annotations

import base64
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from curl_cffi import requests
from urllib.parse import urlsplit
import os


def create_session():
    # A worker is leased by one account at a time. Recreate the curl-cffi
    # session on lease release so cookies and connection state never cross
    # account boundaries.
    return requests.Session(impersonate="chrome")


def emit(value: dict) -> None:
    sys.stdout.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def main() -> None:
    session = create_session()
    for line in sys.stdin:
        if not line.strip():
            continue
        request = json.loads(line)
        request_id = request.get("id")
        bridge = None
        try:
            command = str(request.get("command") or "").strip().lower()
            if command == "reset":
                session.close()
                session = create_session()
                emit({"id": request_id, "ok": True, "reset": True})
                continue
            if command == "close":
                session.close()
                emit({"id": request_id, "ok": True, "closed": True})
                return
            direct = bool(request.get("direct", False))
            proxy = "" if direct else str(request.get("proxy") or os.environ.get("APP_PROXY") or "").strip()
            parsed = urlsplit(proxy if "://" in proxy else (f"http://{proxy}" if proxy else ""))
            # The production image contains no legacy proxy-runtime package.
            # curl_cffi accepts normal proxy URLs (including credentials) directly.
            proxy_for_request = proxy
            session.proxies = ({"http": proxy_for_request, "https": proxy_for_request} if proxy_for_request else {})
            body = request.get("body")
            raw_body = base64.b64decode(body) if body else None
            response = session.request(
                method=str(request.get("method") or "GET"),
                url=str(request.get("url") or ""),
                headers=request.get("headers") or {},
                data=raw_body,
                allow_redirects=bool(request.get("allowRedirects", True)),
                timeout=float(request.get("timeout", 90)),
            )
            headers = []
            for key, value in response.headers.multi_items():
                headers.append([str(key), str(value)])
            emit({
                "id": request_id,
                "status": response.status_code,
                "url": str(response.url),
                "headers": headers,
                "body": base64.b64encode(response.content).decode("ascii"),
            })
        except Exception as error:
            emit({"id": request_id, "error": str(error)})
        finally:
            # Do not retain the previous request/response while the idle worker
            # waits for its next input (reset also drops session cookies).
            line = request = body = raw_body = response = headers = None
            proxy = proxy_for_request = parsed = key = value = None
            if bridge is not None:
                try:
                    bridge.stop()
                except Exception:
                    pass


if __name__ == "__main__":
    main()
