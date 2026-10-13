import json
from http.server import BaseHTTPRequestHandler

from ctd_model import calculate


class handler(BaseHTTPRequestHandler):
    def _headers(self, status=200):
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_OPTIONS(self):
        self._headers(204)

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length))
            result = calculate(payload)
            self._headers(200)
            self.wfile.write(json.dumps(result, allow_nan=False).encode("utf-8"))
        except Exception as exc:
            self._headers(400)
            self.wfile.write(json.dumps({"error": str(exc)}).encode("utf-8"))
