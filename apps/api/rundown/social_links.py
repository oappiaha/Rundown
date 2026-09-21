"""Explicit, read-only public permalink previews via official oEmbed APIs."""
import re
import time
from html.parser import HTMLParser
from threading import Lock
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator

from rundown.collectors import fixture_origin, request_json
from rundown.rss import FeedError, plain_text

router = APIRouter(prefix='/social-links', tags=['social-links'])
_lock = Lock()
_cache: dict[str, tuple[float, dict]] = {}
_last_request = 0.0


def permalink(value: str) -> tuple[str, str]:
    try:
        p = urlsplit(value)
        if (p.scheme != 'https' or p.username is not None or p.password is not None
                or p.port not in {None, 443} or '\\' in value
                or any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in value)):
            raise ValueError
        host = (p.hostname or '').lower()
        if host in {'x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com'}:
            match = re.fullmatch(r'/([A-Za-z0-9_]{1,15})/status/([0-9]{1,25})/?', p.path)
            if match:
                return 'x', f'https://x.com/{match[1]}/status/{match[2]}'
        if host in {'tiktok.com', 'www.tiktok.com'}:
            match = re.fullmatch(r'/@([A-Za-z0-9_.]{1,24})/video/([0-9]{1,25})/?', p.path)
            if match:
                return 'tiktok', f'https://www.tiktok.com/@{match[1]}/video/{match[2]}'
    except ValueError:
        pass
    raise ValueError('Paste a full HTTPS X post or TikTok video link. Short/share links and profile URLs are not supported.')


class PreviewIn(BaseModel):
    model_config = ConfigDict(extra='forbid')
    url: str = Field(min_length=1, max_length=2048)

    @field_validator('url')
    @classmethod
    def check_url(cls, value: str) -> str:
        value = value.strip()
        permalink(value)
        return value


class PostText(HTMLParser):
    """Only retain paragraph text from the post's blockquote, never scripts/widgets."""
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.quote = 0
        self.paragraph = 0
        self.skip = 0
        self.parts: list[str] = []

    def handle_starttag(self, tag, attrs):
        if tag in {'script', 'style'}:
            self.skip += 1
        if tag == 'blockquote':
            self.quote += 1
        if tag == 'p' and self.quote:
            self.paragraph += 1
        if tag == 'br' and self.paragraph:
            self.parts.append('\n')

    def handle_endtag(self, tag):
        if tag in {'script', 'style'}:
            self.skip = max(0, self.skip - 1)
        if tag == 'p' and self.paragraph:
            self.paragraph -= 1
            self.parts.append('\n')
        if tag == 'blockquote':
            self.quote = max(0, self.quote - 1)

    def handle_data(self, data):
        if self.quote and self.paragraph and not self.skip:
            self.parts.append(data)


def fetch_preview(platform: str, url: str) -> dict:
    fixture = fixture_origin()
    endpoint = (fixture + '/' + platform + '/oembed') if fixture else (
        'https://publish.x.com/oembed' if platform == 'x' else 'https://www.tiktok.com/oembed')
    params = {'url': url}
    if platform == 'x':
        params.update(omit_script='true', hide_thread='true', hide_media='true', dnt='true')
    with httpx.Client(timeout=10, follow_redirects=False, trust_env=False) as client:
        payload = request_json(client, 'GET', endpoint, params=params)
    author = payload.get('author_name', '')
    if not isinstance(author, str):
        raise FeedError('Provider returned invalid author metadata. Keep the link and add context manually.')
    if platform == 'x':
        markup = payload.get('html')
        if not isinstance(markup, str) or payload.get('type') != 'rich':
            raise FeedError('Provider did not return a public post preview.')
        parser = PostText()
        parser.feed(markup)
        body = ''.join(parser.parts).strip()
        limitations = 'Public post text only. Replies, linked articles and attached media were not retrieved.'
    else:
        body = payload.get('title')
        if not isinstance(body, str) or payload.get('type') != 'video':
            raise FeedError('Provider did not return a public video caption.')
        # TikTok title is plain caption text; HTML entities/tags are normalized for notes.
        body = plain_text(body).strip()
        limitations = 'Public video caption only. Transcript, comments and video content were not retrieved.'
    if not body.strip():
        raise FeedError('No usable public text was returned. Keep the link and add context manually.')
    title = ' '.join(body.split())[:1000]
    author_text = ' '.join(plain_text(author).split())[:200]
    text = body[:6000]
    name = 'X' if platform == 'x' else 'TikTok'
    context = f'{name} public link\n{limitations}\nAuthor: {author_text or "Not provided"}\n\n{text}'
    return {'platform': platform, 'source_url': url, 'title': title, 'text': text,
            'author': author_text, 'context': context, 'limitations': limitations,
            'truncated': len(body) > 6000 or len(' '.join(body.split())) > 1000 or len(author) > 200,
            'mode': 'fixture' if fixture else 'live'}


@router.post('/preview')
def preview(payload: PreviewIn) -> dict:
    global _last_request
    platform, url = permalink(payload.url)
    if not _lock.acquire(blocking=False):
        raise HTTPException(429, 'Another link preview is running. Wait before trying again.')
    try:
        # Include fixture mode in the key so an operator change cannot reuse mock text.
        origin = fixture_origin()
        key = origin + '|' + url
        now = time.monotonic()
        cached = _cache.get(key)
        if cached and now - cached[0] < 60:
            return cached[1]
        if now - _last_request < 2:
            raise HTTPException(429, 'Wait two seconds before previewing another link.')
        _last_request = now
        result = fetch_preview(platform, url)
        if len(_cache) >= 128:
            _cache.clear()
        _cache[key] = (time.monotonic(), result)
        return result
    except (FeedError, ValueError) as exc:
        message = str(exc) if isinstance(exc, FeedError) else 'Link preview configuration is invalid.'
        raise HTTPException(502, message) from exc
    finally:
        _lock.release()
