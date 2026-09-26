"""Synthetic YouTube/RSS provider on 127.0.0.1:8192 with locally served thumbnails.
Everything here is fictional; no real provider is contacted."""
import json
import struct
import sys
import zlib
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8192
ORIGIN = f'http://127.0.0.1:{PORT}'


def png(width, height, rgb, stripe=None):
    """Minimal solid PNG (with an optional diagonal stripe) so <img> decodes a real bitmap."""
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
    'long-take.png': png(480, 360, (0, 113, 227), (245, 245, 247)),      # landscape, served
    'foley.png': png(480, 360, (29, 29, 31), (120, 200, 232)),           # landscape, served
    'offwhite.png': png(1200, 630, (233, 225, 207), (27, 63, 212)),      # article cover, served
    'portrait.png': png(180, 320, (10, 21, 32), (201, 242, 77)),         # portrait, served
}
NOW = datetime.now(UTC).isoformat()
VIDEOS = [
    ('vid00000001', 'Why the long take came back: how one-shot scenes went from stunt to scheduling decision', 'Directors used to hide cuts inside whip pans and doorways. Today the reason to hold a shot is simpler: a camera that can move like a person and a crew that rehearses a scene like a play.', 'Frame & Field', {'default': {'url': ORIGIN + '/thumbs/long-take.png', 'width': 120, 'height': 90}, 'high': {'url': ORIGIN + '/thumbs/long-take.png', 'width': 480, 'height': 360}}),
    ('vid00000002', 'How a foley artist builds a footstep (broken thumbnail on purpose)', 'Seven minutes inside a pit of gravel, a pair of borrowed boots and a lot of listening.', 'Below the Line', {'high': {'url': ORIGIN + '/thumbs/missing.png', 'width': 480, 'height': 360}}),
    ('vid00000003', 'The grid that ran a newspaper for forty years (no thumbnail offered)', 'A video essay on the twelve-column system one Zurich daily never abandoned.', 'Set in Metal', {'high': {'url': 'javascript:alert(1)', 'width': '²', 'height': True}}),
]
FEED = f'''<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>Surface Notes</title><link>https://example.com/</link><description>Synthetic design journal</description>
<item><guid isPermaLink="false">offwhite</guid><title>Off-white is a decision: paper makers, gallery painters and screen designers on the colour nobody thinks they chose</title><link>https://example.com/off-white</link><author>Tomas Reyes</author><pubDate>Tue, 22 Sep 2026 09:00:00 GMT</pubDate><description><![CDATA[<p>Pure white is a lab value; off-white is a temperature. Museums warm their walls by a few points so paintings do not look cold.</p><p>On screens the choice is stranger, because the light comes from behind.</p>]]></description><media:thumbnail url="{ORIGIN}/thumbs/offwhite.png" width="1200" height="630"/></item>
<item><guid isPermaLink="false">kerning</guid><title>Kerning in twelve seconds (portrait cover)</title><link>https://example.com/kerning</link><description>A type designer fixes a shop sign with a finger and a marker.</description><media:content url="{ORIGIN}/thumbs/portrait.png" medium="image" width="180" height="320"/></item>
<item><guid isPermaLink="false">broken</guid><title>Article whose cover image returns 404</title><link>https://example.com/broken-cover</link><description>The card must still render with artwork.</description><enclosure url="{ORIGIN}/thumbs/gone.png" type="image/png" length="1"/></item>
<item><guid isPermaLink="false">noimage</guid><title>Article with no image at all</title><link>https://example.com/no-image</link><description>Text-first card.</description></item>
</channel></rss>'''.encode()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write('fixture %s %s\n' % (self.command, self.path))

    def send(self, status, body, ctype):
        self.send_response(status)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlparse(self.path).path
        if path == '/youtube/v3/search':
            return self.send(200, json.dumps({'items': [{'id': {'videoId': v[0]}, 'snippet': {'title': 'search excerpt'}} for v in VIDEOS]}).encode(), 'application/json')
        if path == '/youtube/v3/videos':
            return self.send(200, json.dumps({'items': [{'id': i, 'snippet': {'title': t, 'description': d, 'channelTitle': c, 'publishedAt': NOW, 'thumbnails': th}} for i, t, d, c, th in VIDEOS]}).encode(), 'application/json')
        if path == '/feed.xml':
            return self.send(200, FEED, 'application/rss+xml')
        if path.startswith('/thumbs/'):
            name = path.split('/')[-1]
            if name in THUMBS:
                return self.send(200, THUMBS[name], 'image/png')
            return self.send(404, b'no such thumbnail', 'text/plain')
        return self.send(404, b'{"error":"fixture missing"}', 'application/json')


if __name__ == '__main__':
    print('fixture listening on', ORIGIN, flush=True)
    ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
