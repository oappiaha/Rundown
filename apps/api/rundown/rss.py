"""Bounded RSS/Atom retrieval and plain-text extraction; no article fetching."""

import http.client
import ipaddress
import socket
import ssl
import time
from dataclasses import dataclass
from html.parser import HTMLParser
from urllib.parse import urljoin, urlsplit, urlunsplit
from xml.parsers import expat

import feedparser

from rundown.config import settings
from rundown.inbox import CaptureTopic, url_adapter

MAX_BYTES = 2 * 1024 * 1024
MAX_ENTRIES = 100
FETCH_SECONDS = 20


class FeedError(Exception):
    """Safe user-facing import error, without remote response bodies/secrets."""


def canonical_url(value: str) -> str:
    CaptureTopic.safe_url(value)
    parsed = urlsplit(str(url_adapter.validate_python(value)))
    normalized = urlunsplit((parsed.scheme.lower(), parsed.netloc.lower(), parsed.path or '/', parsed.query, ''))
    if len(normalized) > 2048:
        raise ValueError('URL exceeds 2048 characters after normalization.')
    return normalized


def checked_addresses(url: str) -> tuple[str, int, list[str]]:
    parsed = urlsplit(url)
    host = parsed.hostname
    if not host:
        raise FeedError('Feed URL needs a hostname.')
    port = parsed.port or (443 if parsed.scheme == 'https' else 80)
    origin = f'{parsed.scheme}://{parsed.netloc}'
    fixture = settings.rss_test_feed_origin
    # An operator may allow exactly one loopback fixture origin in an isolated
    # process. It cannot enable arbitrary private hosts, ports, or redirects.
    allowed_fixture = bool(fixture and origin == fixture and host in {'127.0.0.1', '::1'})
    try:
        addresses = list(dict.fromkeys(str(info[4][0]) for info in socket.getaddrinfo(
            host, port, type=socket.SOCK_STREAM)))
    except OSError as exc:
        raise FeedError('Could not resolve the feed hostname. Check the URL and try again.') from exc
    if not addresses or (not allowed_fixture and any(
        not ipaddress.ip_address(addr).is_global or ipaddress.ip_address(addr).is_multicast
        for addr in addresses
    )):
        raise FeedError('Feed imports require a public internet address; private and loopback targets are blocked.')
    return host, port, addresses


def fetch_feed(url: str) -> tuple[bytes, str]:
    """Resolve/check each redirect and pin the connection to a checked address."""
    deadline = time.monotonic() + FETCH_SECONDS
    for _ in range(4):
        try:
            url = canonical_url(url)
            host, port, addresses = checked_addresses(url)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise FeedError('Feed request timed out. Try again later.')
            parsed = urlsplit(url)
            conn = http.client.HTTPConnection(host, port, timeout=min(remaining, 8))
            wire = None
            try:
                # Do not let the HTTP library resolve the host a second time.
                wire = socket.create_connection((addresses[0], port), timeout=min(remaining, 8))
                if parsed.scheme == 'https':
                    wire = ssl.create_default_context().wrap_socket(wire, server_hostname=host)
                conn.sock = wire
                conn.request('GET', urlunsplit(('', '', parsed.path or '/', parsed.query, '')),
                             headers={'User-Agent': 'Rundown-RSS/1.0', 'Accept': 'application/atom+xml, application/rss+xml, application/xml, text/xml',
                                      'Accept-Encoding': 'identity', 'Connection': 'close'})
                response = conn.getresponse()
                if response.status in {301, 302, 303, 307, 308}:
                    location = response.getheader('Location')
                    if not location:
                        raise FeedError('The feed redirected without a destination.')
                    url = urljoin(url, location)
                    continue
                if response.status != 200:
                    raise FeedError(f'The feed returned HTTP {response.status}. Check the feed URL or try again later.')
                if response.getheader('Content-Encoding', 'identity').lower() not in {'', 'identity'}:
                    raise FeedError('The feed sent compressed content despite requesting plain XML.')
                length = response.getheader('Content-Length')
                if length and (not length.isdigit() or int(length) > MAX_BYTES):
                    raise FeedError('The feed exceeds the 2 MB import limit.')
                data = bytearray()
                while not response.isclosed():
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise FeedError('Feed request timed out. Try again later.')
                    wire.settimeout(min(remaining, 8))
                    chunk = response.read1(min(65536, MAX_BYTES + 1 - len(data)))
                    if not chunk:
                        break
                    data.extend(chunk)
                    if len(data) > MAX_BYTES:
                        raise FeedError('The feed exceeds the 2 MB import limit.')
                return bytes(data), url
            finally:
                conn.close()
                if wire is not None:
                    wire.close()
        except FeedError:
            raise
        except (OSError, http.client.HTTPException) as exc:
            raise FeedError('Could not download the feed (network, TLS or timeout error). Try again later.') from exc
        except ValueError as exc:
            raise FeedError('The feed or its redirect has an invalid URL.') from exc
    raise FeedError('The feed redirected too many times.')


class PlainText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.hidden = 0

    def handle_starttag(self, tag, attrs):
        if tag in {'script', 'style'}:
            self.hidden += 1
        if tag in {'p', 'div', 'br', 'li', 'h1', 'h2', 'h3'} and not self.hidden:
            self.parts.append('\n')

    def handle_endtag(self, tag):
        if tag in {'script', 'style'}:
            self.hidden = max(0, self.hidden - 1)
        if tag in {'p', 'div', 'li'} and not self.hidden:
            self.parts.append('\n')

    def handle_data(self, data):
        if not self.hidden:
            self.parts.append(data)


def plain_text(value: str) -> str:
    parser = PlainText()
    parser.feed(value)
    return '\n'.join(line.strip() for line in ''.join(parser.parts).splitlines() if line.strip())


@dataclass
class Entry:
    identity: str
    url: str
    title: str
    body: str
    published: str | None
    truncated: bool


def parse_feed(data: bytes, feed_url: str) -> tuple[list[Entry | dict], list[str]]:
    if len(data) > MAX_BYTES:
        raise FeedError('The feed exceeds the 2 MB import limit.')
    # Validate XML before feedparser's forgiving parser. DTD callbacks work
    # regardless of document encoding, and reject entities before expansion.
    parser = expat.ParserCreate()
    def reject_dtd(*args):
        raise FeedError('Feeds with document types or entity declarations are not supported.')
    parser.StartDoctypeDeclHandler = reject_dtd
    parser.EntityDeclHandler = reject_dtd
    try:
        parser.Parse(data, True)
    except expat.ExpatError as exc:
        raise FeedError('This is not a well-formed RSS or Atom XML feed.') from exc
    parsed = feedparser.parse(data, response_headers={'content-location': feed_url})
    if not parsed.get('version'):
        raise FeedError('This URL did not return a recognized RSS or Atom feed.')
    warnings = []
    if len(parsed.entries) > MAX_ENTRIES:
        warnings.append('Only the first 100 entries were examined. Older entries were not imported.')
    entries: list[Entry | dict] = []
    for entry in parsed.entries[:MAX_ENTRIES]:
        title = plain_text(str(entry.get('title', ''))).strip()
        link = str(entry.get('link', '')).strip()
        if not title or not link:
            entries.append({'title': title[:100], 'reason': 'Missing title or article link.'})
            continue
        try:
            link = canonical_url(urljoin(feed_url, link))
        except ValueError:
            entries.append({'title': title[:100], 'reason': 'Article link is not a valid HTTP(S) URL.'})
            continue
        content = entry.get('content', [])
        body = plain_text(str(content[0].get('value', '') if content else entry.get('summary', '')))
        entries.append(Entry(identity=str(entry.get('id') or link), url=link, title=title[:1000],
                             body=body[:50000], published=str(entry.get('published') or entry.get('updated') or '')[:120] or None,
                             truncated=len(body) > 50000 or len(title) > 1000))
    return entries, warnings
