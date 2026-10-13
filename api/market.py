import csv
import json
from datetime import date
from http.server import BaseHTTPRequestHandler
from urllib.request import urlopen


def load_market_data():
    url = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS10,DGS20,DGS30&cosd=2000-01-01"
    with urlopen(url, timeout=30) as response:
        text = response.read().decode("utf-8")
    rows = csv.DictReader(text.splitlines())
    points = []
    for row in rows:
        values = []
        for key in ("DGS10", "DGS20", "DGS30"):
            try:
                values.append(float(row[key]))
            except (TypeError, ValueError):
                values.append(None)
        if all(value is not None for value in values):
            points.append({"date": row.get("observation_date", row.get("DATE")),
                           "dgs10": values[0], "dgs20": values[1], "dgs30": values[2]})
    if not points:
        raise RuntimeError("FRED returned no complete 10/20/30-year yield observations")
    return {"source": "FRED / U.S. Treasury H.15", "as_of": points[-1]["date"], "points": points}


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            result = load_market_data()
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "s-maxage=1800, stale-while-revalidate=3600")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(result).encode("utf-8"))
        except Exception as exc:
            self.send_response(502)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(exc)}).encode("utf-8"))
