"""Bounded official-API adapters. No browser profiles, scraping or paid services."""
import json
import re
import time
from datetime import UTC, datetime
from urllib.parse import parse_qs, urlsplit

import httpx

from rundown.config import settings
from rundown.models import RetrievalSource
from rundown.rss import Entry, FeedError, plain_text

MAX_BYTES = 2 * 1024 * 1024


def fixture_origin() -> str:
    value = settings.retrieval_test_origin
    if value:
        parsed = urlsplit(value)
        if (parsed.scheme != 'http' or parsed.hostname != '127.0.0.1' or not parsed.port
                or parsed.path or parsed.query or parsed.fragment or parsed.username is not None):
            raise FeedError('Retrieval fixture must be an explicit loopback HTTP origin.')
    return value


def availability(platform: str) -> str | None:
    try:
        if fixture_origin():
            return None
    except (ValueError, FeedError):
        return 'Retrieval fixture configuration is invalid.'
    if platform == 'youtube':
        return None if settings.youtube_api_key else 'Configure YOUTUBE_API_KEY to search YouTube.'
    if not settings.reddit_api_approved:
        return 'Reddit requires approved API access; configure REDDIT_API_APPROVED after approval.'
    if not (settings.reddit_client_id and settings.reddit_client_secret and settings.reddit_user_agent):
        return 'Configure REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET and REDDIT_USER_AGENT.'
    return None


def request_json(client: httpx.Client, method: str, url: str, **kwargs) -> dict:
    try:
        with client.stream(method, url, **kwargs) as response:
            if response.status_code != 200:
                if response.status_code == 429:
                    raise FeedError('Provider rate limit reached. Wait before collecting again.')
                if response.status_code in {401, 403}:
                    raise FeedError('Provider denied access. Check API approval, credentials and quota.')
                raise FeedError(f'Provider returned HTTP {response.status_code}. Try again later.')
            data = bytearray()
            deadline = time.monotonic() + 20
            for chunk in response.iter_bytes(chunk_size=65536):
                data.extend(chunk)
                if len(data) > MAX_BYTES or time.monotonic() > deadline:
                    raise FeedError('Provider response exceeded the size or time limit.')
            result = json.loads(data)
            if not isinstance(result, dict):
                raise ValueError('object required')
            return result
    except FeedError:
        raise
    except (httpx.HTTPError, ValueError, UnicodeError) as exc:
        raise FeedError('Provider response could not be read. No items were imported.') from exc


def youtube_metadata(client: httpx.Client, rows: list, limit: int, fixture: str) -> list:
    """Join bounded search results to video metadata by ID, preserving search order."""
    ids: list[str] = []
    for row in rows[:limit]:
        identity = row.get('id') if isinstance(row, dict) else None
        ident = identity.get('videoId') if isinstance(identity, dict) else None
        if isinstance(ident, str) and re.fullmatch(r'[A-Za-z0-9_-]{11}', ident) and ident not in ids:
            ids.append(ident)
    if not ids:
        return rows
    payload = request_json(client, 'GET', (fixture or 'https://www.googleapis.com') + '/youtube/v3/videos',
                           params={'part': 'snippet', 'id': ','.join(ids),
                                   'key': 'fixture' if fixture else settings.youtube_api_key})
    videos = payload.get('items')
    if not isinstance(videos, list):
        raise FeedError('Provider response is missing video metadata. No items were imported.')
    by_id: dict[str, object] = {}
    for video in videos:
        if not isinstance(video, dict):
            continue
        ident = video.get('id')
        if not isinstance(ident, str) or ident not in ids:
            continue
        if ident in by_id:
            raise FeedError('Provider returned conflicting video metadata. No items were imported.')
        by_id[ident] = video.get('snippet')
    enriched = []
    for row in rows[:limit]:
        identity = row.get('id') if isinstance(row, dict) else None
        ident = identity.get('videoId') if isinstance(identity, dict) else None
        # Never substitute the search excerpt when full metadata is unavailable.
        snippet = by_id.get(ident) if isinstance(ident, str) else None
        enriched.append({'id': identity, 'snippet': snippet})
    return enriched + rows[limit:]


def collect(source: RetrievalSource) -> tuple[list[Entry], int]:
    reason = availability(source.platform)
    if reason:
        raise FeedError(reason)
    fixture = fixture_origin()
    since = time.time() - source.freshness_hours * 3600
    with httpx.Client(timeout=10, follow_redirects=False, trust_env=False) as client:
        if source.platform == 'youtube':
            params = {'part': 'snippet', 'type': 'video', 'order': 'date',
                      'maxResults': str(source.limit),
                      'publishedAfter': datetime.fromtimestamp(since, UTC).isoformat(),
                      'key': 'fixture' if fixture else settings.youtube_api_key}
            if source.query:
                params['q'] = source.query
            if source.scope:
                params['channelId'] = source.scope
            payload = request_json(client, 'GET', (fixture or 'https://www.googleapis.com') + '/youtube/v3/search', params=params)
            rows = payload.get('items')
            if isinstance(rows, list):
                rows = youtube_metadata(client, rows, source.limit, fixture)
        else:
            agent = 'Rundown-Fixture/1.0' if fixture else settings.reddit_user_agent
            token = request_json(client, 'POST', (fixture or 'https://www.reddit.com') + '/api/v1/access_token',
                                 auth=('fixture', 'fixture') if fixture else (settings.reddit_client_id, settings.reddit_client_secret),
                                 data={'grant_type': 'client_credentials'}, headers={'User-Agent': agent})
            access = token.get('access_token')
            if not isinstance(access, str) or not access or len(access) > 4096:
                raise FeedError('Reddit did not issue an access token. Check app approval and credentials.')
            prefix = '/r/' + source.scope if source.scope else ''
            path = prefix + ('/search' if source.query else '/new')
            query = {'limit': str(source.limit), 'raw_json': '1'}
            if source.query:
                query.update(q=source.query, sort='new', t='all', restrict_sr='true' if source.scope else 'false')
            payload = request_json(client, 'GET', (fixture or 'https://oauth.reddit.com') + path,
                                   params=query, headers={'User-Agent': agent, 'Authorization': 'Bearer ' + access})
            rows = payload.get('data', {}).get('children') if isinstance(payload.get('data'), dict) else None
    if not isinstance(rows, list):
        raise FeedError('Provider response is missing its results list. No items were imported.')
    entries: list[Entry] = []
    skipped = max(0, len(rows) - source.limit)
    for row in rows[:source.limit]:
        try:
            if source.platform == 'youtube':
                ident = row['id']['videoId']
                if not isinstance(ident, str) or not re.fullmatch(r'[A-Za-z0-9_-]{11}', ident):
                    raise ValueError('invalid video')
                snippet = row['snippet']
                title, body = snippet['title'], snippet.get('description', '')
                author = snippet.get('channelTitle', '')
                stamp = datetime.fromisoformat(snippet['publishedAt'].replace('Z', '+00:00'))
                if stamp.tzinfo is None:
                    raise ValueError('missing timezone')
                published = stamp.timestamp()
                url = 'https://www.youtube.com/watch?v=' + ident
                content = 'Video description only; transcript and video have not been retrieved.'
            else:
                post = row['data']
                ident = post['id']
                if not isinstance(ident, str) or not re.fullmatch(r'[a-z0-9]{1,20}', ident):
                    raise ValueError('invalid post')
                title, body = post['title'], post.get('selftext', '')
                if body in {'[removed]', '[deleted]'} or post.get('removed_by_category'):
                    raise ValueError('unavailable post')
                author = 'r/' + post.get('subreddit', '')
                published = float(post['created_utc'])
                url = 'https://www.reddit.com/comments/' + ident + '/'
                content = 'Post title and body only; linked articles and comments have not been retrieved.'
            if not all(isinstance(x, str) for x in [title, body, author]) or not title.strip():
                raise ValueError('invalid text')
            if not since <= published <= time.time() + 300:
                raise ValueError('outside freshness window')
            full_title = ' '.join(plain_text(title).split())
            title = full_title[:1000]
            if not title:
                raise ValueError('empty title')
            context = f'{content}\nChannel/community: {plain_text(author)[:200]}\n\n{plain_text(body)}'
            if source.platform == 'youtube' and not plain_text(body).strip():
                context += 'No description provided by the publisher.'
            truncated = len(context) > 6000 or len(full_title) > 1000
            entries.append(Entry(source.platform + ':' + ident, url, title, context[:6000],
                                 datetime.fromtimestamp(published, UTC).isoformat(), truncated))
        except (KeyError, TypeError, ValueError, AttributeError, OverflowError, OSError):
            skipped += 1
    return entries, skipped


def platform_identity(url: str) -> str | None:
    """Recognize common public permalink forms without resolving/fetching them."""
    try:
        parsed = urlsplit(url)
        host = (parsed.hostname or '').lower()
        path = parsed.path.strip('/').split('/')
        ident = None
        if host in {'youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'}:
            if host == 'youtu.be':
                ident = path[0]
            elif path[0] == 'watch':
                ident = parse_qs(parsed.query).get('v', [''])[0]
            elif len(path) >= 2 and path[0] in {'shorts', 'live'}:
                ident = path[1]
            if ident and re.fullmatch(r'[A-Za-z0-9_-]{11}', ident):
                return 'youtube:' + ident
        if host in {'reddit.com', 'www.reddit.com', 'old.reddit.com', 'new.reddit.com', 'm.reddit.com', 'redd.it'}:
            if host == 'redd.it':
                ident = path[0]
            elif len(path) >= 2 and path[0] == 'comments':
                ident = path[1]
            elif len(path) >= 4 and path[0] == 'r' and path[2] == 'comments':
                ident = path[3]
            if ident and re.fullmatch(r'[a-z0-9]{1,20}', ident):
                return 'reddit:' + ident
    except ValueError:
        pass
    return None
