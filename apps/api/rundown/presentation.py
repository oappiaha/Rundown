"""Card metadata validation for imported topics. Nothing here fetches images."""

import ipaddress
import re
from datetime import UTC, datetime
from typing import TYPE_CHECKING
from urllib.parse import urlsplit

from rundown.config import settings
from rundown.models import TopicPresentation

if TYPE_CHECKING:
    from rundown.rss import Entry

MAX_URL = 2048
MAX_DIMENSION = 10000
MAX_CREATOR = 200
MAX_EXCERPT = 500


def fixture_origins() -> set[str]:
    """Loopback origins an operator configured for isolated verification only."""
    return {o for o in (settings.rss_test_feed_origin, settings.retrieval_test_origin) if o}


def safe_image_url(value: object) -> str | None:
    """Return the URL when it is a public absolute http(s) address, else None.

    Private, loopback, link-local and multicast IP literals and `localhost`
    are rejected without any DNS lookup; hostnames are not resolved here.
    """
    if not isinstance(value, str):
        return None
    url = value.strip()
    if not url or len(url) > MAX_URL or '\\' in url:
        return None
    if any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in url):
        return None
    try:
        parsed = urlsplit(url)
        host = parsed.hostname
        port = parsed.port
    except ValueError:
        return None
    if parsed.scheme.lower() not in {'http', 'https'} or not host:
        return None
    if parsed.username is not None or parsed.password is not None:
        return None
    origin = f'{parsed.scheme.lower()}://{parsed.netloc.lower()}'
    if origin in fixture_origins():
        return url
    if port is not None and not 1 <= port <= 65535:
        return None
    lowered = host.lower().rstrip('.')
    if lowered == 'localhost' or lowered.endswith('.localhost') or lowered.endswith('.local'):
        return None
    try:
        address = ipaddress.ip_address(lowered.strip('[]'))
    except ValueError:
        # Not a canonical IP literal. Browsers still parse hosts whose last
        # label is numeric ("127.1", "0x7f000001", "2130706433") as IPv4, so
        # only accept dotted names whose final label starts with a letter.
        return url if re.fullmatch(r'([a-z0-9-]+\.)+[a-z][a-z0-9-]*', lowered) else None
    return url if address.is_global and not address.is_multicast else None


def dimension(value: object) -> int | None:
    """A plain ASCII integer 1..10000; anything else (bools, '²', huge strings) is None."""
    if isinstance(value, bool):
        return None
    if isinstance(value, str):
        value = value.strip()
        if not value.isascii() or not value.isdigit() or len(value) > 6:
            return None
        value = int(value)
    if isinstance(value, int) and 1 <= value <= MAX_DIMENSION:
        return value
    return None


def choose_thumbnail(candidates: list[object]) -> tuple[str, int | None, int | None] | None:
    """Pick the widest valid candidate; entries are dicts with url/width/height."""
    best: tuple[str, int | None, int | None] | None = None
    for candidate in candidates:
        try:
            if not isinstance(candidate, dict):
                continue
            url = safe_image_url(candidate.get('url'))
            if url is None:
                continue
            width, height = dimension(candidate.get('width')), dimension(candidate.get('height'))
        except (TypeError, ValueError, AttributeError):
            # Malformed optional metadata drops the image, never the story.
            continue
        if best is None or (width or 0) > (best[1] or 0):
            best = (url, width, height)
    return best


def clean_text(value: object, limit: int) -> str:
    if not isinstance(value, str):
        return ''
    return ' '.join(value.split())[:limit]


def from_entry(topic_id: str, provider: str, entry: 'Entry', now: float) -> TopicPresentation:
    """Card metadata for a freshly imported topic; the topic itself is saved regardless."""
    ready = entry.thumbnail_url is not None
    return TopicPresentation(inbox_topic_id=topic_id, provider=provider, creator=entry.creator[:MAX_CREATOR],
                             excerpt=entry.excerpt[:MAX_EXCERPT], thumbnail_url=entry.thumbnail_url,
                             thumbnail_width=entry.thumbnail_width, thumbnail_height=entry.thumbnail_height,
                             media_seconds=entry.media_seconds, state='ready' if ready else 'partial',
                             reason=None if ready else 'The source offered no usable image.', fetched_at=now)


def detail(row: TopicPresentation | None) -> dict | None:
    if row is None:
        return None
    thumbnail = None
    if row.thumbnail_url:
        thumbnail = {'url': row.thumbnail_url, 'width': row.thumbnail_width, 'height': row.thumbnail_height}
    return {'provider': row.provider, 'creator': row.creator, 'excerpt': row.excerpt, 'thumbnail': thumbnail,
            'media_seconds': row.media_seconds, 'state': row.state, 'reason': row.reason,
            'fetched_at': datetime.fromtimestamp(row.fetched_at, UTC).isoformat()}
