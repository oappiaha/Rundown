"""Signed, short-lived carrier for an accepted link preview.

The preview endpoint extracts metadata from a page or an official oEmbed
answer and hands the client a token. On save the client returns the token,
never the fields, so nothing the browser sends is trusted as provider data.
The key lives only in this process (never in settings, .env or the database);
a restart simply expires outstanding previews, which the client handles by
saving without the preview.
"""

import base64
import hashlib
import hmac
import json
import re
import secrets
import time

TOKEN_SECONDS = 30 * 60
# Upper bound of the encoded payload: title 1000 and description 6000 characters
# at up to 4 UTF-8 bytes each, three 2048-character URLs, two 200-character
# names, a 120-character date and JSON overhead, then base64 (4/3) plus the
# signature. Anything larger is a programming error, never a user error.
MAX_TOKEN = 96 * 1024
_KEY = secrets.token_bytes(32)
_SIGNATURE = re.compile(r'[A-Za-z0-9_-]{43}')

FIELDS = ('kind', 'source_url', 'resolved_url', 'title', 'description', 'site_name', 'creator',
          'published_at', 'thumbnail', 'truncated')


class TokenError(ValueError):
    """Why a preview token is not usable; safe to show the user."""


def _sign(body: bytes) -> str:
    return base64.urlsafe_b64encode(hmac.new(_KEY, body, hashlib.sha256).digest()).decode().rstrip('=')


def issue(meta: dict, now: float | None = None) -> tuple[str, float]:
    """Return the token and its expiry (epoch seconds)."""
    issued = time.time() if now is None else now
    payload = {key: meta.get(key) for key in FIELDS}
    payload['iat'] = issued
    body = base64.urlsafe_b64encode(json.dumps(payload, separators=(',', ':'), ensure_ascii=False).encode()).decode().rstrip('=')
    token = f'{body}.{_sign(body.encode())}'
    if len(token) > MAX_TOKEN:
        raise TokenError('The preview metadata is too large to carry. Save the link without the preview.')
    return token, issued + TOKEN_SECONDS


def verify(token: str, source_url: str, now: float | None = None) -> dict:
    """Return the metadata the server issued for exactly this entered URL."""
    if not isinstance(token, str) or not token or len(token) > MAX_TOKEN or token.count('.') != 1:
        raise TokenError('The preview is not valid. Preview the link again, or save it without the preview.')
    body, signature = token.split('.', 1)
    # Compare bytes: compare_digest raises TypeError on non-ASCII str input.
    if not _SIGNATURE.fullmatch(signature) or not hmac.compare_digest(_sign(body.encode()).encode(), signature.encode()):
        raise TokenError('The preview is not valid. Preview the link again, or save it without the preview.')
    try:
        padded = body + '=' * (-len(body) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded.encode()))
    except (ValueError, UnicodeError) as exc:
        raise TokenError('The preview is not valid. Preview the link again, or save it without the preview.') from exc
    if not isinstance(payload, dict) or not isinstance(payload.get('iat'), int | float):
        raise TokenError('The preview is not valid. Preview the link again, or save it without the preview.')
    current = time.time() if now is None else now
    if not payload['iat'] <= current <= payload['iat'] + TOKEN_SECONDS:
        raise TokenError('The preview expired. Preview the link again, or save it without the preview.')
    if payload.get('source_url') != source_url:
        raise TokenError('The preview was made for a different link. Preview again, or save the link without it.')
    return {key: payload.get(key) for key in FIELDS}
