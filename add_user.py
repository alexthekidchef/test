#!/usr/bin/env python3
"""Add/update users in accounts.json with PBKDF2 hashes.
Usage:
  python add_user.py accounts.json username password "/index.html" "/rt/*" "/station_status.html"
If you omit routes, it will default to ["*"].
"""
import sys, json, os, base64, hashlib

def b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode("ascii").rstrip("=")

def pbkdf2_hash(password: str, salt: bytes | None=None, iterations: int=200_000, dklen: int=32):
    if salt is None:
        salt = os.urandom(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations, dklen=dklen)
    return {
        "algo": "pbkdf2_sha256",
        "salt": b64u(salt),
        "hash": b64u(dk),
        "iter": iterations,
        "dklen": dklen,
    }

def main():
    if len(sys.argv) < 4:
        print(__doc__.strip())
        sys.exit(1)
    path, username, password = sys.argv[1], sys.argv[2], sys.argv[3]
    routes = sys.argv[4:] or ["*"]
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    data[username] = {**pbkdf2_hash(password), "routes": routes}
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    print(f"Updated {username} with routes: {routes}")

if __name__ == "__main__":
    main()
