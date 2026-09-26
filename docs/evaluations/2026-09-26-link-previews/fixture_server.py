"""Synthetic article pages, TikTok oEmbed and thumbnails on 127.0.0.1:8192.
Everything here is fictional; no real site or provider is contacted."""
import json
import struct
import sys
import time
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8192
ORIGIN = f'http://127.0.0.1:{PORT}'


def png(width, height, rgb, stripe=None):
    raw = bytearray()
    for y in range(height):
        raw.append(0)
        for x in range(width):
            color = stripe if stripe and (x + y) % 40 < 12 else rgb
            raw.extend(color)
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(bytes(raw), 9)) + chunk(b'IEND', b''))


THUMBS = {
    'offwhite.png': png(1200, 630, (233, 225, 207), (27, 63, 212)),
    'second.png': png(300, 300, (200, 40, 40)),
    'cover-rel.png': png(600, 400, (120, 160, 90), (245, 241, 232)),
    'portrait.png': png(360, 640, (10, 21, 32), (201, 242, 77)),
}

LONG_HEADLINE = ('A very long fictional headline about how a small coastal newsroom rebuilt its entire archive by hand over '
                 'eleven winters, and what the people who did it say they would tell anyone starting the same job today '
                 'without a budget, a plan or a deadline')
assert len(LONG_HEADLINE) > 200

PAGES = {
    'offwhite.html': f'''<!doctype html><html><head><meta charset="utf-8">
<title>Fallback title tag (should lose to og:title)</title>
<meta property="og:title" content="Off-white is a decision: paper makers, gallery painters and screen designers on the colour nobody thinks they chose">
<meta property="og:description" content="Pure white is a lab value; off-white is a temperature. Museums warm their walls by a few points so paintings do not look cold.">
<meta property="og:site_name" content="Surface Notes">
<meta name="author" content="Tomas Reyes">
<meta property="article:published_time" content="2026-09-22T09:00:00Z">
<meta property="og:image" content="{ORIGIN}/thumbs/offwhite.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image" content="{ORIGIN}/thumbs/second.png">
<meta property="og:image:width" content="300">
<meta property="og:image:height" content="300">
<script>document.write('<meta property="og:title" content="SCRIPT TITLE">')</script>
<style>/* <meta property="og:title" content="STYLE TITLE"> */</style>
</head><body>
<meta property="og:title" content="BODY TITLE MUST BE IGNORED">
<meta property="og:image" content="http://10.0.0.1/body.png">
<p>Article body that is never fetched as text.</p></body></html>''',
    'long-headline.html': f'''<!doctype html><html><head><meta charset="utf-8">
<meta property="OG:Title" content="{LONG_HEADLINE}">
<meta property="og:description" content="Relative image, no dimensions, mixed-case property name.">
<meta property="og:image" content="/thumbs/cover-rel.png">
<meta name="description" content="Standard description should lose to og:description.">
</head><body></body></html>''',
    'body-only.html': '''<!doctype html><html><head><meta charset="utf-8"><title>Body-only page: plain title only</title></head>
<body><meta property="og:title" content="BODY OG TITLE"><meta property="og:description" content="BODY DESC"><meta property="og:image" content="http://127.0.0.1:8192/thumbs/second.png"></body></html>''',
    'xss.html': '''<!doctype html><html><head><meta charset="utf-8">
<meta property="og:title" content="Quotes &quot;and&quot; &lt;script&gt;alert(1)&lt;/script&gt; in a headline">
<meta property="og:description" content="Description with <b>tags</b> &amp; entities">
<meta property="og:site_name" content="<img src=x onerror=alert(2)>">
<meta property="og:image" content="javascript:alert(3)">
<meta property="twitter:image" content="http://127.0.0.1:8192/thumbs/second.png">
</head><body></body></html>''',
    'no-metadata.html': '<!doctype html><html><head><meta charset="utf-8"></head><body><h1>Nothing in head</h1></body></html>',
}


def oversize(late):
    head = '<!doctype html><html><head><meta charset="utf-8">'
    meta = '<meta property="og:title" content="Oversize page headline"><meta property="og:description" content="Metadata placed %s the cap.">' % ('before' if not late else 'after')
    filler = '<!-- ' + 'x' * 1000 + ' -->\n'
    if late:
        return (head + filler * 400 + meta + '</head><body></body></html>').encode()
    return (head + meta + '</head><body>' + filler * 1200 + '</body></html>').encode()


CAPTION = 'Fixing a shop sign with a finger and a marker #kerning #type'
OEMBED = {
    '7000000000000000001': (200, {'type': 'video', 'version': '1.0', 'title': CAPTION, 'author_name': 'synthetic.maker', 'author_url': 'https://www.tiktok.com/@synthetic.maker',
                                  'thumbnail_url': ORIGIN + '/thumbs/portrait.png', 'thumbnail_width': 360, 'thumbnail_height': 640, 'html': '<blockquote class="tiktok-embed">never rendered</blockquote><script src="https://www.tiktok.com/embed.js"></script>'}),
    '7000000000000000002': (403, {'error': 'private'}),
    '7000000000000000003': (429, {'error': 'slow down'}),
    '7000000000000000004': (200, {'type': 'video', 'title': 'Huge caption ' + 'word ' * 3000, 'author_name': 'verbose.maker', 'thumbnail_url': ORIGIN + '/thumbs/portrait.png', 'thumbnail_width': 360, 'thumbnail_height': 640}),
    '7000000000000000005': (200, {'type': 'video', 'title': 'Author is not a string', 'author_name': {'bad': 1}, 'thumbnail_url': ORIGIN + '/thumbs/portrait.png'}),
    '7000000000000000006': (200, {'type': 'video', 'title': 'Private thumbnail host is dropped', 'author_name': 'edge.maker', 'thumbnail_url': 'http://10.0.0.1/x.jpg', 'thumbnail_width': '²', 'thumbnail_height': True}),
    '7000000000000000007': (200, None),  # malformed JSON
    '7000000000000000008': (200, {'type': 'rich', 'title': 'Not a video', 'author_name': 'x'}),
}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write('fixture %s %s\n' % (self.command, self.path))

    def send(self, status, body, ctype, extra=None):
        self.send_response(status)
        self.send_header('Content-Type', ctype)
        if not (extra and 'Content-Length' in extra):
            self.send_header('Content-Length', str(len(body)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def redirect(self, location):
        self.send_response(302)
        self.send_header('Location', location)
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path.startswith('/thumbs/'):
            name = path.split('/')[-1]
            if name in THUMBS:
                return self.send(200, THUMBS[name], 'image/png')
            return self.send(404, b'no such thumbnail', 'text/plain')
        if path == '/tiktok/oembed':
            url = parse_qs(parsed.query).get('url', [''])[0]
            ident = url.rstrip('/').split('/')[-1]
            status, payload = OEMBED.get(ident, (404, {'error': 'not found'}))
            body = b'{"type": "video", "title": ' if payload is None else json.dumps(payload).encode()
            return self.send(status, body, 'application/json')
        if path.startswith('/articles/'):
            name = path.split('/')[-1]
            if name in PAGES:
                return self.send(200, PAGES[name].encode(), 'text/html; charset=utf-8')
            if name == 'redirect':
                return self.redirect('/articles/offwhite.html?from=redirect')
            if name == 'private-redirect':
                return self.redirect('http://10.0.0.1/secret.html')
            if name == 'loopback-redirect':
                return self.redirect('http://127.0.0.1:1/blocked.html')
            if name == 'loop':
                return self.redirect('/articles/loop')
            if name == 'forbidden':
                return self.send(403, b'<html><head><meta property="og:title" content="FORBIDDEN BODY MUST NOT APPEAR"></head></html>', 'text/html')
            if name == 'ratelimited':
                return self.send(429, b'<html><head><title>RATE LIMIT BODY</title></head></html>', 'text/html')
            if name == 'missing':
                return self.send(404, b'<html><head><title>NOT FOUND BODY</title></head></html>', 'text/html')
            if name == 'server-error':
                return self.send(503, b'<html><head><title>503 BODY</title></head></html>', 'text/html')
            if name == 'notes.json':
                return self.send(200, json.dumps({'og:title': 'JSON is not a page'}).encode(), 'application/json')
            if name == 'image.png':
                return self.send(200, THUMBS['second.png'], 'image/png')
            if name == 'malformed.html':
                return self.send(200, b'\x00\xff\xfe<<<>>>\x89PNG not html at all \xc3\x28', 'text/html')
            if name == 'oversize.html':
                return self.send(200, oversize(False), 'text/html; charset=utf-8')
            if name == 'oversize-late.html':
                return self.send(200, oversize(True), 'text/html; charset=utf-8')
            if name == 'bad-length.html':
                return self.send(200, PAGES['offwhite.html'].encode(), 'text/html', {'Content-Length': 'abc'})
            if name == 'gzip.html':
                return self.send(200, PAGES['offwhite.html'].encode(), 'text/html', {'Content-Encoding': 'gzip'})
            if name == 'slow-long.html':
                time.sleep(3)
                return self.send(200, PAGES['long-headline.html'].encode(), 'text/html; charset=utf-8')
            if name == 'slow.html':
                time.sleep(12)
                return self.send(200, PAGES['offwhite.html'].encode(), 'text/html')
            return self.send(404, b'<html><head><title>NOT FOUND BODY</title></head></html>', 'text/html')
        return self.send(404, b'{"error":"fixture missing"}', 'application/json')


if __name__ == '__main__':
    print('fixture listening on', ORIGIN, flush=True)
    ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
