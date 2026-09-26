"""Explicit, read-only previews of a pasted article page or TikTok permalink.

A preview fetches once, on the user's request, through the same bounded
public-address transport RSS uses (article `<head>` metadata) or the official
TikTok oEmbed endpoint. It stores nothing; the accepted metadata comes back as
a signed token that `POST /inbox/capture` verifies. Remote HTML is parsed for
`<meta>`/`<title>` text only and is never rendered; the backend never fetches
images, it only validates their addresses.
"""

import re
import time
from datetime import UTC, datetime
from html.parser import HTMLParser
from threading import Lock
from urllib.parse import urljoin, urlsplit

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator

from rundown import presentation, preview_token
from rundown.collectors import fixture_origin, request_json
from rundown.inbox import CaptureTopic
from rundown.rss import FeedError, StatusError, fetch_public, plain_text
from rundown.social_links import permalink

router = APIRouter(prefix='/link-previews', tags=['link-previews'])

PAGE_BYTES = 256 * 1024
PAGE_SECONDS = 10
MAX_TITLE = 1000
MAX_DESCRIPTION = 6000
MAX_NAME = 200
SOCIAL_HOSTS = {'x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com', 'tiktok.com', 'www.tiktok.com',
                'vm.tiktok.com', 'vt.tiktok.com', 'm.tiktok.com'}
MANUAL = ' Save the link and add a title manually.'

_lock = Lock()
_cache: dict[str, tuple[float, dict]] = {}
_last_request = 0.0


class PreviewIn(BaseModel):
    model_config = ConfigDict(extra='forbid')
    url: str = Field(min_length=1, max_length=2048)

    @field_validator('url')
    @classmethod
    def check_url(cls, value: str) -> str:
        # Exactly the rule manual capture applies, so the entered URL the
        # token binds to is the URL the topic will store.
        return CaptureTopic.safe_url(value.strip())


def classify(url: str) -> tuple[str, str]:
    """('tiktok', canonical permalink) or ('article', url as entered)."""
    host = (urlsplit(url).hostname or '').lower()
    if host in SOCIAL_HOSTS:
        platform, canonical = permalink(url)  # raises ValueError with its own message
        if platform != 'tiktok':
            raise ValueError('X posts have no image preview here. Save the link and add context manually.')
        return 'tiktok', canonical
    return 'article', url


class HeadMeta(HTMLParser):
    """`<meta>` and `<title>` from the document head only. Script/style
    content is CDATA to the parser and never yields tags; parsing stops at
    `</head>` or the first `<body>`, whichever comes first. Metadata before an
    explicit `<head>` counts as the implied head (HTML parsing rules), so a
    page without the tag still previews. Open Graph image roots keep their
    own structured properties (ogp.me): a width that follows the second image
    belongs to it, and `og:image:url`/`og:image:secure_url` without a
    preceding root is a root of its own (ogp.me: identical to `og:image`)."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.meta: dict[str, str] = {}
        self.images: list[dict[str, str]] = []
        self.title_parts: list[str] = []
        self.in_title = False
        self.done = False

    def handle_starttag(self, tag, attrs):
        if self.done:
            return
        if tag == 'body':
            self.done = True
            return
        if tag == 'title':
            self.in_title = True
            return
        if tag != 'meta':
            return
        attributes = {name: value for name, value in attrs if isinstance(value, str)}
        key = (attributes.get('property') or attributes.get('name') or '').strip().lower()
        content = attributes.get('content')
        if not key or content is None:
            return
        if key == 'og:image':
            self.images.append({'url': content})
        elif key in {'og:image:url', 'og:image:secure_url'}:
            if self.images and 'explicit' not in self.images[-1]:
                self.images[-1]['url'] = content
                self.images[-1]['explicit'] = key
            else:
                self.images.append({'url': content, 'explicit': key})
        elif key in {'og:image:width', 'og:image:height'}:
            if self.images:
                self.images[-1][key.rsplit(':', 1)[1]] = content
        elif key not in self.meta:
            # First occurrence wins, as ogp.me prefers the first tag.
            self.meta[key] = content

    def handle_endtag(self, tag):
        if tag == 'title':
            self.in_title = False
        if tag == 'head':
            self.done = True

    def handle_data(self, data):
        if self.in_title and not self.done:
            self.title_parts.append(data)


def charset_of(content_type: str) -> str:
    match = re.search(r'charset\s*=\s*"?([A-Za-z0-9_.:-]{1,40})', content_type)
    if match:
        try:
            b''.decode(match[1])
            return match[1]
        except LookupError:
            pass
    return 'utf-8'


def first_image(candidates: list[dict[str, str]], base: str) -> tuple[str, int | None, int | None] | None:
    """The first Open Graph image whose (resolved) address is a public http(s) URL."""
    for candidate in candidates:
        raw = candidate.get('url', '').strip()
        if not raw:
            continue
        try:
            resolved = urljoin(base, raw)
        except ValueError:
            continue
        url = presentation.safe_image_url(resolved)
        if url is None:
            continue
        return url, presentation.dimension(candidate.get('width')), presentation.dimension(candidate.get('height'))
    return None


def clean(value: object, limit: int) -> str:
    # Strip after the cut so a bounded value never ends in a space that a later
    # whitespace collapse (persistence) would remove, changing the stored text.
    return presentation.clean_text(plain_text(value) if isinstance(value, str) else '', limit).strip()


def article_preview(url: str) -> dict:
    try:
        fetched = fetch_public(url, accept='text/html, application/xhtml+xml;q=0.9', max_bytes=PAGE_BYTES, seconds=PAGE_SECONDS,
                               label='page', what='Link previews', limit_text='256 KB', plain='plain HTML',
                               user_agent='Rundown-LinkPreview/1.0', truncate=True)
    except StatusError as exc:
        if exc.status in {401, 403}:
            raise FeedError(f'The site refused the request (HTTP {exc.status}).' + MANUAL) from exc
        if exc.status == 404:
            raise FeedError('The page was not found (HTTP 404). Check the link.' + MANUAL) from exc
        if exc.status == 429:
            raise FeedError('The site is rate limiting requests (HTTP 429). Try again later.' + MANUAL) from exc
        raise FeedError(f'The site returned HTTP {exc.status}.' + MANUAL) from exc
    media_type = fetched.content_type.split(';', 1)[0].strip().lower()
    if media_type not in {'text/html', 'application/xhtml+xml'}:
        raise FeedError('The link is not an HTML page, so there is no page metadata to preview.' + MANUAL)
    parser = HeadMeta()
    try:
        parser.feed(fetched.data.decode(charset_of(fetched.content_type), errors='replace'))
    except (AssertionError, ValueError) as exc:
        raise FeedError('The page could not be parsed.' + MANUAL) from exc
    meta = parser.meta
    title = clean(meta.get('og:title') or meta.get('twitter:title') or ''.join(parser.title_parts), MAX_TITLE)
    if not title:
        raise FeedError('The page offered no title or preview metadata.' + MANUAL)
    description = clean(meta.get('og:description') or meta.get('description') or meta.get('twitter:description'), MAX_DESCRIPTION)
    host = (urlsplit(fetched.url).hostname or '').lower()
    site = clean(meta.get('og:site_name'), MAX_NAME) or host
    author = clean(meta.get('author'), MAX_NAME)
    if not author:
        candidate = clean(meta.get('article:author'), MAX_NAME)
        author = '' if candidate.lower().startswith(('http://', 'https://')) else candidate
    published = clean(meta.get('article:published_time'), 120) or None
    image = first_image(parser.images, fetched.url)
    if image is None:
        twitter = meta.get('twitter:image') or meta.get('twitter:image:src')
        image = first_image([{'url': twitter}], fetched.url) if isinstance(twitter, str) else None
    return {'kind': 'article', 'source_url': url, 'resolved_url': fetched.url, 'title': title, 'description': description,
            'site_name': site, 'creator': author or site, 'published_at': published,
            'thumbnail': {'url': image[0], 'width': image[1], 'height': image[2]} if image else None,
            'truncated': fetched.truncated or len(title) >= MAX_TITLE or len(description) >= MAX_DESCRIPTION}


def tiktok_preview(entered: str, canonical: str) -> dict:
    fixture = fixture_origin()
    endpoint = (fixture + '/tiktok/oembed') if fixture else 'https://www.tiktok.com/oembed'
    try:
        with httpx.Client(timeout=10, follow_redirects=False, trust_env=False) as client:
            payload = request_json(client, 'GET', endpoint, params={'url': canonical})
    except FeedError as exc:
        raise FeedError(f'{exc} Save the link and add the caption manually.') from exc
    caption = payload.get('title')
    author = payload.get('author_name', '')
    if payload.get('type') != 'video' or not isinstance(caption, str) or not isinstance(author, str):
        raise FeedError('TikTok did not return a public video caption. Save the link and add context manually.')
    title = clean(caption, MAX_TITLE)
    if not title:
        raise FeedError('TikTok returned an empty caption. Save the link and add context manually.')
    thumbnail = None
    image = presentation.safe_image_url(payload.get('thumbnail_url'))
    if image:
        thumbnail = {'url': image, 'width': presentation.dimension(payload.get('thumbnail_width')),
                     'height': presentation.dimension(payload.get('thumbnail_height'))}
    return {'kind': 'tiktok', 'source_url': entered, 'resolved_url': canonical, 'title': title,
            'description': clean(caption, MAX_DESCRIPTION), 'site_name': 'TikTok', 'creator': clean(author, MAX_NAME),
            'published_at': None, 'thumbnail': thumbnail,
            'truncated': len(' '.join(caption.split())) > MAX_TITLE or len(author) > MAX_NAME}


def fetch_preview(url: str) -> dict:
    kind, target = classify(url)
    return tiktok_preview(url, target) if kind == 'tiktok' else article_preview(target)


@router.post('/preview')
def preview(payload: PreviewIn) -> dict:
    global _last_request
    url = payload.url
    try:
        classify(url)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    if not _lock.acquire(blocking=False):
        raise HTTPException(429, 'Another link preview is running. Wait before trying again.')
    try:
        fixture = fixture_origin()
        key = fixture + '|' + url
        now = time.monotonic()
        cached = _cache.get(key)
        if cached and now - cached[0] < 60:
            meta = cached[1]
        else:
            if now - _last_request < 2:
                raise HTTPException(429, 'Wait two seconds before previewing another link.')
            _last_request = now
            meta = fetch_preview(url)
            if len(_cache) >= 128:
                _cache.clear()
            _cache[key] = (time.monotonic(), meta)
        token, expires = preview_token.issue(meta)
        return {**meta, 'token': token, 'expires_at': datetime.fromtimestamp(expires, UTC).isoformat(),
                'mode': 'fixture' if fixture else 'live'}
    except (FeedError, ValueError) as exc:
        message = str(exc) if isinstance(exc, FeedError) else 'Link preview configuration is invalid.'
        raise HTTPException(502, message) from exc
    finally:
        _lock.release()
