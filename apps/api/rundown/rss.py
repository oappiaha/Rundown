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

from rundown import presentation
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


class StatusError(FeedError):
    """A non-success HTTP status from the remote; the body is never kept."""

    def __init__(self, message: str, status: int):
        super().__init__(message)
        self.status = status


@dataclass
class Fetched:
    data: bytes
    url: str  # final URL after checked redirects
    content_type: str
    truncated: bool


def checked_addresses(url: str, label: str = 'feed', what: str = 'Feed imports') -> tuple[str, int, list[str]]:
    parsed = urlsplit(url)
    host = parsed.hostname
    if not host:
        raise FeedError(f'{label.capitalize()} URL needs a hostname.')
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
        raise FeedError(f'Could not resolve the {label} hostname. Check the URL and try again.') from exc
    if not addresses or (not allowed_fixture and any(
        not ipaddress.ip_address(addr).is_global or ipaddress.ip_address(addr).is_multicast
        for addr in addresses
    )):
        raise FeedError(f'{what} require a public internet address; private and loopback targets are blocked.')
    return host, port, addresses


def fetch_public(url: str, *, accept: str, max_bytes: int, seconds: float, label: str = 'feed',
                 what: str = 'Feed imports', limit_text: str = '2 MB import', plain: str = 'plain XML',
                 user_agent: str = 'Rundown-RSS/1.0', truncate: bool = False) -> Fetched:
    """Bounded GET of one public document.

    Every hop (including each redirect) is canonicalized, resolved and checked
    against the public-address rule, and the socket is pinned to the checked
    address so the HTTP library never resolves the host again. Compressed
    bodies are refused. With `truncate=False` a body over `max_bytes` is an
    error; with `truncate=True` the first `max_bytes` are returned and the
    result is marked truncated (metadata that lives in a document head does
    not need the rest). Remote error bodies are never returned.
    """
    deadline = time.monotonic() + seconds
    cap = label.capitalize()
    for _ in range(4):
        try:
            url = canonical_url(url)
            host, port, addresses = checked_addresses(url, label, what)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise FeedError(f'{cap} request timed out. Try again later.')
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
                             headers={'User-Agent': user_agent, 'Accept': accept,
                                      'Accept-Encoding': 'identity', 'Connection': 'close'})
                response = conn.getresponse()
                if response.status in {301, 302, 303, 307, 308}:
                    location = response.getheader('Location')
                    if not location:
                        raise FeedError(f'The {label} redirected without a destination.')
                    url = urljoin(url, location)
                    continue
                if response.status != 200:
                    raise StatusError(f'The {label} returned HTTP {response.status}. Check the {label} URL or try again later.',
                                      response.status)
                if response.getheader('Content-Encoding', 'identity').lower() not in {'', 'identity'}:
                    raise FeedError(f'The {label} sent compressed content despite requesting {plain}.')
                length = response.getheader('Content-Length')
                truncated = False
                if length and not length.isdigit():
                    raise FeedError(f'The {label} sent an invalid length header.' if truncate
                                    else f'The {label} exceeds the {limit_text} limit.')
                if length and int(length) > max_bytes:
                    if not truncate:
                        raise FeedError(f'The {label} exceeds the {limit_text} limit.')
                    truncated = True
                data = bytearray()
                while not response.isclosed():
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise FeedError(f'{cap} request timed out. Try again later.')
                    wire.settimeout(min(remaining, 8))
                    chunk = response.read1(min(65536, max_bytes + 1 - len(data)))
                    if not chunk:
                        break
                    data.extend(chunk)
                    if len(data) > max_bytes:
                        if not truncate:
                            raise FeedError(f'The {label} exceeds the {limit_text} limit.')
                        del data[max_bytes:]
                        truncated = True
                        break
                return Fetched(bytes(data), url, response.getheader('Content-Type', '') or '', truncated)
            finally:
                conn.close()
                if wire is not None:
                    wire.close()
        except FeedError:
            raise
        except TimeoutError as exc:
            raise FeedError(f'{cap} request timed out. Try again later.') from exc
        except (OSError, http.client.HTTPException) as exc:
            raise FeedError(f'Could not download the {label} (network, TLS or timeout error). Try again later.') from exc
        except ValueError as exc:
            raise FeedError(f'The {label} or its redirect has an invalid URL.') from exc
    raise FeedError(f'The {label} redirected too many times.')


def fetch_feed(url: str) -> tuple[bytes, str]:
    """Resolve/check each redirect and pin the connection to a checked address."""
    fetched = fetch_public(url, accept='application/atom+xml, application/rss+xml, application/xml, text/xml',
                           max_bytes=MAX_BYTES, seconds=FETCH_SECONDS)
    return fetched.data, fetched.url


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
    # Optional card metadata; positional callers predate these defaults.
    creator: str = ''
    thumbnail_url: str | None = None
    thumbnail_width: int | None = None
    thumbnail_height: int | None = None
    media_seconds: int | None = None
    excerpt: str = ''


def entry_media(entry: dict, feed_url: str) -> list[object]:
    """Media RSS thumbnails, image media content and image enclosures, in that order."""
    found: list[object] = []
    try:
        get = entry.get
        # A missing or empty address is skipped: urljoin would otherwise
        # turn the feed document itself into the "thumbnail".
        for item in get('media_thumbnail') or []:
            if isinstance(item, dict) and isinstance(item.get('url'), str) and item['url'].strip():
                found.append({**item, 'url': urljoin(feed_url, item['url'].strip())})
        for item in get('media_content') or []:
            if (isinstance(item, dict) and isinstance(item.get('url'), str) and item['url'].strip()
                    and (str(item.get('medium', '')).lower() == 'image'
                         or str(item.get('type', '')).lower().startswith('image/'))):
                found.append({**item, 'url': urljoin(feed_url, item['url'].strip())})
        for item in get('enclosures') or []:
            if (isinstance(item, dict) and str(item.get('type', '')).lower().startswith('image/')
                    and isinstance(item.get('href'), str) and item['href'].strip()):
                found.append({'url': urljoin(feed_url, item['href'].strip())})
    except (TypeError, ValueError, AttributeError):
        return found
    return found


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
    feed_meta = parsed.get('feed')
    feed_title = str(feed_meta.get('title', '')) if isinstance(feed_meta, dict) else ''
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
        thumbnail = presentation.choose_thumbnail(entry_media(entry, feed_url))
        creator = presentation.clean_text(plain_text(str(entry.get('author') or feed_title or '')),
                                          presentation.MAX_CREATOR)
        entries.append(Entry(identity=str(entry.get('id') or link), url=link, title=title[:1000],
                             body=body[:50000], published=str(entry.get('published') or entry.get('updated') or '')[:120] or None,
                             truncated=len(body) > 50000 or len(title) > 1000,
                             creator=creator, thumbnail_url=thumbnail[0] if thumbnail else None,
                             thumbnail_width=thumbnail[1] if thumbnail else None,
                             thumbnail_height=thumbnail[2] if thumbnail else None,
                             excerpt=presentation.clean_text(body, presentation.MAX_EXCERPT)))
    return entries, warnings
