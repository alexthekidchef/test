from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import urlopen, Request
from urllib.error import URLError, HTTPError
from urllib.parse import urlparse, parse_qs
import json, os, time, base64, hashlib, hmac, threading, secrets
from typing import Optional, List, Dict, Any, Tuple

AMTRAKER_BASE = "https://api-v3.amtraker.com/v3"

# === Optional regional filters ===
NEC_STATION_CODES = {"BOS","BBY","RTE","PVD","KIN","WLY","MYS","NLC","OSB","NHV","BRP","STM","NRO","NYP","NWK","EWR","MET","NBK","PJC","TRE","CWH","PHN","PHL","WIL","NRK","ABD","EDW","BWI","BAL","NCR","WAS"}
# Rough bounding box covering the Northeast Corridor (fallback)
NEC_BBOX = {"min_lat": 38.0, "max_lat": 43.6, "min_lon": -77.6, "max_lon": -70.5}
NEC_ROUTE_NAME_HINTS = ('Acela', 'Northeast Regional', 'Keystone Service', 'Cardinal', 'Carolinian', 'Crescent', 'Palmetto', 'Silver Meteor', 'Silver Star', 'Vermonter')

def _in_bbox(obj):
    try:
        lat = float(obj.get("lat", obj.get("latitude")))
        lon = float(obj.get("lon", obj.get("lng", obj.get("longitude"))))
    except Exception:
        return False
    return (NEC_BBOX["min_lat"] <= lat <= NEC_BBOX["max_lat"]) and (NEC_BBOX["min_lon"] <= lon <= NEC_BBOX["max_lon"])

def _mentions_nec_station(obj):
    for k in ("station", "stationCode", "code", "from", "to", "origin", "destination", "nextStation", "prevStation", "lastStation"):
        v = obj.get(k)
        if isinstance(v, str) and v in NEC_STATION_CODES:
            return True
    for k in ("stations", "stops", "routeStations"):
        v = obj.get(k)
        if isinstance(v, list):
            for it in v:
                if isinstance(it, str) and it in NEC_STATION_CODES:
                    return True
                if isinstance(it, dict):
                    c = it.get("code") or it.get("stationCode") or it.get("station")
                    if isinstance(c, str) and c in NEC_STATION_CODES:
                        return True
    return False

def filter_nec_stations(payload):
    if isinstance(payload, list):
        out = []
        for s in payload:
            if isinstance(s, dict):
                code = s.get("code") or s.get("stationCode") or s.get("id")
                if isinstance(code, str) and code in NEC_STATION_CODES:
                    out.append(s)
        return out if out else payload
    if isinstance(payload, dict):
        for key in ("stations", "data", "results"):
            if isinstance(payload.get(key), list):
                payload[key] = filter_nec_stations(payload[key])
                return payload
    return payload

def filter_nec_trains(payload):
    def keep_train(t):
        if not isinstance(t, dict):
            return False
        rn = t.get("routeName") or t.get("route") or t.get("service") or ""
        if isinstance(rn, str) and any(h.lower() in rn.lower() for h in NEC_ROUTE_NAME_HINTS):
            return True
        if _mentions_nec_station(t):
            return True
        if _in_bbox(t):
            return True
        return False

    if isinstance(payload, list):
        out = [t for t in payload if keep_train(t)]
        return out if out else payload
    if isinstance(payload, dict):
        for key in ("trains", "data", "results"):
            if isinstance(payload.get(key), list):
                payload[key] = [t for t in payload[key] if keep_train(t)]
                return payload
    return payload

def filter_nec_data_file(relpath: str, raw_bytes: bytes) -> bytes:
    """Filter GTFS-derived ./data/*.json payloads for NEC-only users."""
    try:
        payload = json.loads(raw_bytes.decode("utf-8"))
    except Exception:
        return raw_bytes

    # stops.json: dict keyed by station code
    if relpath.endswith("stops.json") and isinstance(payload, dict):
        payload = {k:v for (k,v) in payload.items() if k in NEC_STATION_CODES}
        return json.dumps(payload).encode("utf-8")

    # tripmap.json: dict keyed by tripId -> meta
    if relpath.endswith("tripmap.json") and isinstance(payload, dict):
        def keep_trip(meta: dict) -> bool:
            if not isinstance(meta, dict): 
                return False
            rn = (meta.get("rl") or meta.get("rs") or "")
            if isinstance(rn, str) and any(h.lower() in rn.lower() for h in NEC_ROUTE_NAME_HINTS):
                return True
            return False
        payload = {tid:meta for (tid,meta) in payload.items() if keep_trip(meta)}
        return json.dumps(payload).encode("utf-8")

    # stop_events.json: dict keyed by station code -> list of [arr, dep, tripId]
    if relpath.endswith("stop_events.json") and isinstance(payload, dict):
        # Need allowed tripIds from (already-filtered) tripmap
        try:
            tripmap_path = os.path.join(os.path.dirname(__file__), "data", "tripmap.json")
            tripmap_all = json.load(open(tripmap_path, "r", encoding="utf-8"))
            allowed_tripids = set()
            for tid, meta in (tripmap_all or {}).items():
                rn = (meta.get("rl") or meta.get("rs") or "")
                if isinstance(rn, str) and any(h.lower() in rn.lower() for h in NEC_ROUTE_NAME_HINTS):
                    allowed_tripids.add(str(tid))
        except Exception:
            allowed_tripids = None

        out = {}
        for st, evs in payload.items():
            if st not in NEC_STATION_CODES: 
                continue
            if not isinstance(evs, list):
                continue
            if allowed_tripids is None:
                out[st] = evs
            else:
                out[st] = [e for e in evs if isinstance(e, list) and len(e) >= 3 and str(e[2]) in allowed_tripids]
        return json.dumps(out).encode("utf-8")

    # services_by_date.json: date -> [serviceIds]
    if relpath.endswith("services_by_date.json") and isinstance(payload, dict):
        # allowed services from NEC trips (based on tripmap)
        try:
            tripmap_path = os.path.join(os.path.dirname(__file__), "data", "tripmap.json")
            tripmap_all = json.load(open(tripmap_path, "r", encoding="utf-8"))
            allowed_svcs = set()
            for meta in (tripmap_all or {}).values():
                if not isinstance(meta, dict): 
                    continue
                rn = (meta.get("rl") or meta.get("rs") or "")
                if isinstance(rn, str) and any(h.lower() in rn.lower() for h in NEC_ROUTE_NAME_HINTS):
                    svc = meta.get("svc")
                    if svc:
                        allowed_svcs.add(str(svc))
        except Exception:
            allowed_svcs = None

        if allowed_svcs is None:
            return raw_bytes
        out = {}
        for d, svcs in payload.items():
            if isinstance(svcs, list):
                out[d] = [s for s in svcs if str(s) in allowed_svcs]
            else:
                out[d] = svcs
        return json.dumps(out).encode("utf-8")

    return raw_bytes




# === Auth config ===
ACCOUNTS_FILE = os.path.join(os.path.dirname(__file__), "accounts.json")
SESSION_COOKIE = "amtrak_session"
SESSION_TTL_SECONDS = 8 * 60 * 60  # 8 hours

# In-memory session store (not persisted to disk; not stored in the browser beyond an HttpOnly cookie)
_sessions = {}  # token -> {"username": str, "routes": [str], "exp": float}
_sessions_lock = threading.Lock()

# Cache accounts.json for fast reloads
_accounts_cache = {"mtime": 0, "data": {}}
_accounts_lock = threading.Lock()

def _b64u_decode(s: str) -> bytes:
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode((s + pad).encode("ascii"))

def load_accounts():
    """Load accounts.json; auto-reload if file changed."""
    try:
        mtime = os.path.getmtime(ACCOUNTS_FILE)
    except FileNotFoundError:
        return {}
    with _accounts_lock:
        if mtime != _accounts_cache["mtime"]:
            with open(ACCOUNTS_FILE, "r", encoding="utf-8") as f:
                _accounts_cache["data"] = json.load(f)
            _accounts_cache["mtime"] = mtime
        return _accounts_cache["data"]

def verify_password(stored: dict, password: str) -> bool:
    # PBKDF2 SHA-256 (built-in, no extra deps)
    if stored.get("algo") != "pbkdf2_sha256":
        return False
    salt = _b64u_decode(stored["salt"])
    expected = _b64u_decode(stored["hash"])
    iterations = int(stored.get("iter", 200_000))
    dklen = int(stored.get("dklen", len(expected)))
    got = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations, dklen=dklen)
    return hmac.compare_digest(got, expected)

def create_session(username: str, routes: List[str], filters: Optional[dict]=None) -> str:
    token = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode("ascii").rstrip("=")
    exp = time.time() + SESSION_TTL_SECONDS
    with _sessions_lock:
        _sessions[token] = {"username": username, "routes": routes, "filters": (filters or {}), "exp": exp}
    return token

def get_session(token: str):
    if not token:
        return None
    with _sessions_lock:
        s = _sessions.get(token)
        if not s:
            return None
        if s["exp"] < time.time():
            _sessions.pop(token, None)
            return None
        return s

def destroy_session(token: str):
    if not token:
        return
    with _sessions_lock:
        _sessions.pop(token, None)

def match_route(allowed: str, path: str) -> bool:
    # "*" matches everything
    if allowed == "*" or allowed == "/*":
        return True
    # prefix wildcard like "/rt/*"
    if allowed.endswith("*"):
        return path.startswith(allowed[:-1])
    # exact
    return path == allowed

def is_authorized(session: dict, path: str) -> bool:
    # Normalize root -> index
    if path == "/":
        path = "/index.html"
    routes = session.get("routes") or []
    return any(match_route(r, path) for r in routes)

def proxy_json(url, timeout=25):
    req = Request(url, headers={
        "User-Agent": "amtrak-board-local-proxy",
        "Accept": "application/json",
    })

    def _open(ctx=None):
        if ctx is None:
            with urlopen(req, timeout=timeout) as resp:
                return resp.read(), resp.headers.get("Content-Type","application/json; charset=utf-8")
        else:
            with urlopen(req, timeout=timeout, context=ctx) as resp:
                return resp.read(), resp.headers.get("Content-Type","application/json; charset=utf-8")

    try:
        return _open()
    except Exception as e:
        # Common on some macOS Python builds: missing/old CA bundle -> CERTIFICATE_VERIFY_FAILED
        msg = str(e)
        if "CERTIFICATE_VERIFY_FAILED" in msg or "certificate verify failed" in msg:
            try:
                if certifi:
                    ctx = ssl.create_default_context(cafile=certifi.where())
                else:
                    ctx = ssl._create_unverified_context()
                return _open(ctx)
            except Exception:
                # final fallback: unverified (local proxy only)
                ctx = ssl._create_unverified_context()
                return _open(ctx)
        raise

class Handler(SimpleHTTPRequestHandler):
    # ---- Helpers ----
    def send_json(self, code: int, obj: dict, extra_headers: Optional[dict]=None):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        if extra_headers:
            for k,v in extra_headers.items():
                self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def read_json_body(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        raw = self.rfile.read(length) if length > 0 else b"{}"
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return None

    def get_cookie(self, name: str) -> Optional[str]:
        cookie = self.headers.get("Cookie", "")
        parts = [c.strip() for c in cookie.split(";") if c.strip()]
        for p in parts:
            if p.startswith(name + "="):
                return p.split("=", 1)[1]
        return None

    def set_session_cookie(self, token: Optional[str]):
        # HttpOnly means JS can't read it (so credentials/session aren't stored in localStorage)
        # SameSite=Lax works well for localhost navigation.
        if token:
            value = f"{SESSION_COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax"
        else:
            value = f"{SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax"
        self.send_header("Set-Cookie", value)

    def require_auth(self, path: str):
        token = self.get_cookie(SESSION_COOKIE)
        session = get_session(token)
        if not session:
            return None, "not_logged_in"
        if not is_authorized(session, path):
            return None, "forbidden"
        return session, None

    # ---- POST endpoints (login/logout) ----
    def do_POST(self):
        if self.path.startswith("/auth/login"):
            body = self.read_json_body()
            if not body or "username" not in body or "password" not in body:
                return self.send_json(400, {"error":"bad_request"})
            username = str(body["username"]).strip()
            password = str(body["password"])
            accounts = load_accounts()
            rec = accounts.get(username)
            if not rec or not verify_password(rec, password):
                return self.send_json(401, {"error":"invalid_credentials"})

            token = create_session(username, rec.get("routes", []), rec.get("filters"))
            # Set cookie + return basic info
            self.send_response(200)
            self.set_session_cookie(token)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(json.dumps({"ok": True, "username": username, "routes": rec.get("routes", [])}).encode("utf-8"))
            return

        if self.path.startswith("/auth/logout"):
            token = self.get_cookie(SESSION_COOKIE)
            destroy_session(token)
            self.send_response(200)
            self.set_session_cookie(None)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(b'{"ok":true}')
            return

        self.send_json(404, {"error":"not_found"})

    # ---- GET endpoints ----
    def do_GET(self):
        # Public files
        PUBLIC_PATHS = {
            "/login.html", "/login.js",
        }
        
        # Auth API
        if self.path.startswith("/auth/me"):
            token = self.get_cookie(SESSION_COOKIE)
            session = get_session(token)
            if not session:
                return self.send_json(401, {"error":"not_logged_in"})
            return self.send_json(200, {"ok": True, "username": session["username"], "routes": session["routes"], "filters": session.get("filters", {}), "exp": session["exp"]})

        # Health check (public)
        if self.path.startswith("/rt/ping"):
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(b'{"ok":true}')
            return

        # Normalize just the path part (strip query)
        parsed = urlparse(self.path)
        path_only = parsed.path

        # Force start on login page
        if path_only in ("/", "/index.html"):
            token = self.get_cookie(SESSION_COOKIE)
            session = get_session(token)
            if not session:
                self.send_response(302)
                self.send_header("Location", "/login.html")
                self.end_headers()
                return

        # Gate everything except explicit public paths and static assets
        static_public_prefixes = ("/favicon", "/assets/")
        is_public = (path_only in PUBLIC_PATHS) or path_only.endswith(".css") or path_only.endswith(".png") or path_only.endswith(".jpg") or path_only.endswith(".svg") or path_only.endswith(".ico") or path_only.startswith(static_public_prefixes)

        # Allow JS files if the *page* is authorized; otherwise, block JS too (except login.js)
        if path_only.endswith(".js") and path_only != "/login.js":
            is_public = False

        # Also allow the batch helper script to be downloaded only when logged in with access to it
        if path_only in ("/add_user.py",):
            is_public = False

        # Protected realtime endpoints
        if path_only.startswith("/rt/") and path_only not in ("/rt/ping",):
            session, err = self.require_auth(path_only)
            if err == "not_logged_in":
                return self.send_json(401, {"error":"not_logged_in"})
            if err == "forbidden":
                return self.send_json(403, {"error":"forbidden"})
            # Proxy routes
            if path_only.startswith("/rt/trains"):
                try:
                    data, ctype = proxy_json(f"{AMTRAKER_BASE}/trains")
                    # Apply optional regional filter
                    if session.get("filters", {}).get("region") == "nec":
                        try:
                            payload = json.loads(data.decode("utf-8"))
                            payload = filter_nec_trains(payload)
                            data = json.dumps(payload).encode("utf-8")
                            ctype = "application/json; charset=utf-8"
                        except Exception:
                            pass
                    self.send_response(200)
                    self.send_header("Content-Type", ctype)
                    self.send_header("Cache-Control", "no-store")
                    self.end_headers()
                    self.wfile.write(data)
                except (URLError, HTTPError) as e:
                    msg = str(e)
                    code = getattr(e, "code", None)
                    body = ""
                    try:
                        if hasattr(e, "read"):
                            body = e.read().decode("utf-8","ignore")[:500]
                    except Exception:
                        pass
                    self.send_json(502, {"error":"proxy_failed","upstream_status":code,"message":msg,"body":body})
                return

            if path_only.startswith("/rt/stations"):
                try:
                    data, ctype = proxy_json(f"{AMTRAKER_BASE}/stations")
                    # Apply optional regional filter
                    if session.get("filters", {}).get("region") == "nec":
                        try:
                            payload = json.loads(data.decode("utf-8"))
                            payload = filter_nec_stations(payload)
                            data = json.dumps(payload).encode("utf-8")
                            ctype = "application/json; charset=utf-8"
                        except Exception:
                            pass
                    self.send_response(200)
                    self.send_header("Content-Type", ctype)
                    self.send_header("Cache-Control", "no-store")
                    self.end_headers()
                    self.wfile.write(data)
                except (URLError, HTTPError) as e:
                    self.send_json(502, {"error":"proxy_failed","message":str(e)})
                return

            if path_only.startswith("/rt/stale"):
                try:
                    data, ctype = proxy_json(f"{AMTRAKER_BASE}/stale")
                    self.send_response(200)
                    self.send_header("Content-Type", ctype)
                    self.send_header("Cache-Control", "no-store")
                    self.end_headers()
                    self.wfile.write(data)
                except (URLError, HTTPError) as e:
                    self.send_json(502, {"error":"proxy_failed","message":str(e)})
                return

            return self.send_json(404, {"error":"not_found"})

        # Protect HTML routes by default (everything except index/login)
        if (path_only.endswith(".html") or path_only in ("/",)) and (path_only not in PUBLIC_PATHS):
            token = self.get_cookie(SESSION_COOKIE)
            session = get_session(token)
            if not session:
                # redirect to login with next=
                next_q = base64.urlsafe_b64encode(path_only.encode("utf-8")).decode("ascii").rstrip("=")
                self.send_response(302)
                self.send_header("Location", f"/login.html?next={next_q}")
                self.end_headers()
                return
            if not is_authorized(session, path_only):
                self.send_response(403)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(b"<!doctype html><meta charset='utf-8'><title>Forbidden</title><h1>403 Forbidden</h1><p>Your account does not have access to this page.</p>")
                return

        # Protect JS (and any other non-public paths) similarly
        if not is_public and not path_only.startswith("/rt/"):
            token = self.get_cookie(SESSION_COOKIE)
            session = get_session(token)
            if not session:
                return self.send_json(401, {"error":"not_logged_in"})
            if not is_authorized(session, path_only):
                return self.send_json(403, {"error":"forbidden"})

        # Serve /data/* with auth + optional NEC filtering
        if path_only.startswith("/data/"):
            session, err = self.require_auth(path_only)
            if err == "not_logged_in":
                return self.send_json(401, {"error":"not_logged_in"})
            if err == "forbidden":
                return self.send_json(403, {"error":"forbidden"})
            try:
                relpath = path_only.lstrip("/")
                fs_path = self.translate_path(path_only)
                if not os.path.isfile(fs_path):
                    return self.send_json(404, {"error":"not_found"})
                with open(fs_path, "rb") as f:
                    raw = f.read()
                if session.get("filters", {}).get("region") == "nec" and relpath.endswith(".json"):
                    raw = filter_nec_data_file(relpath, raw)
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(raw)
                return
            except Exception as e:
                return self.send_json(500, {"error":"data_read_failed","message":str(e)})

        return super().do_GET()

if __name__ == "__main__":
    print("Serving on http://localhost:8000")
    print("Login:   http://localhost:8000/login.html")
    print("Health:  http://localhost:8000/rt/ping")
    print("Realtime (auth): http://localhost:8000/rt/trains")
    ThreadingHTTPServer(("0.0.0.0", 8000), Handler).serve_forever()
