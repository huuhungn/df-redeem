import http.server, socketserver
class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin','*')
        self.send_header('Cache-Control','no-store, max-age=0')
        super().end_headers()
socketserver.TCPServer.allow_reuse_address=True
with socketserver.TCPServer(('127.0.0.1',8732),H) as s:
    s.serve_forever()
