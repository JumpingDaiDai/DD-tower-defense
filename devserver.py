"""
本地開發伺服器：手機連進來玩遊戲，console log / 錯誤 / 截圖會自動存回這台電腦。
用法：在這個資料夾執行 `python devserver.py`，再用手機瀏覽器打開印出來的網址（需同一個 WiFi）。
"""
import http.server
import socketserver
import socket
import json
import os
import datetime
import secrets

PORT = 8000
ROOT = os.path.dirname(os.path.abspath(__file__))
LOG_FILE = os.path.join(ROOT, 'debug.log')
SHOT_DIR = os.path.join(ROOT, 'screenshots')
TOKEN_FILE = os.path.join(ROOT, '.debug_token')
os.makedirs(SHOT_DIR, exist_ok=True)

# 驗證用的共用密鑰：第一次執行會自動產生並存檔，之後重跑會沿用同一把，
# 不用每次重啟都回去改 game.js 裡的 token。
if os.path.exists(TOKEN_FILE):
    with open(TOKEN_FILE, 'r', encoding='utf-8') as f:
        DEBUG_TOKEN = f.read().strip()
else:
    DEBUG_TOKEN = secrets.token_hex(8)
    with open(TOKEN_FILE, 'w', encoding='utf-8') as f:
        f.write(DEBUG_TOKEN)

with open(LOG_FILE, 'w', encoding='utf-8') as f:
    f.write(f"=== Log session started {datetime.datetime.now()} ===\n")


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_POST(self):
        if self.headers.get('X-Debug-Token') != DEBUG_TOKEN:
            self.send_response(401)
            self.end_headers()
            return

        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length) if length else b''

        if self.path == '/__log':
            try:
                data = json.loads(body.decode('utf-8'))
                entries = data if isinstance(data, list) else [data]
                with open(LOG_FILE, 'a', encoding='utf-8') as f:
                    for e in entries:
                        level = str(e.get('level', 'log')).upper()
                        msg = e.get('msg', '')
                        ts = datetime.datetime.now().strftime('%H:%M:%S')
                        line = f"[{ts}] [{level}] {msg}"
                        f.write(line + '\n')
                        print(line)
            except Exception as ex:
                print('log parse error:', ex)
            self.send_response(204)
            self.end_headers()

        elif self.path == '/__upload':
            try:
                fname = os.path.join(
                    SHOT_DIR,
                    datetime.datetime.now().strftime('%Y%m%d_%H%M%S') + '.png'
                )
                with open(fname, 'wb') as f:
                    f.write(body)
                print('已儲存截圖:', fname)
            except Exception as ex:
                print('upload error:', ex)
            self.send_response(204)
            self.end_headers()

        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        pass  # 靜音預設的 request log，我們自己印


def get_local_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('8.8.8.8', 80))
        return s.getsockname()[0]
    except Exception:
        return '127.0.0.1'
    finally:
        s.close()


if __name__ == '__main__':
    os.chdir(ROOT)
    ip = get_local_ip()
    with socketserver.TCPServer(('0.0.0.0', PORT), Handler) as httpd:
        print(f"手機瀏覽器打開: http://{ip}:{PORT}/index.html")
        print(f"Log 即時寫入: {LOG_FILE}")
        print(f"截圖存放於: {SHOT_DIR}")
        print(f"驗證 token: {DEBUG_TOKEN}  (需與 game.js 裡的 DEBUG_TOKEN 一致)")
        print("按 Ctrl+C 停止")
        httpd.serve_forever()
