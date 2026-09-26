"""Card metadata ingest/readback, editorial state, and additive schema upgrade."""
from datetime import UTC, datetime
from uuid import uuid4

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import inspect, text
from sqlmodel import SQLModel, select

from rundown import collectors, db, presentation, rss, show
from rundown.config import settings
from rundown.main import app
from rundown.models import (
    InboxSource,
    InboxTopic,
    RetrievalSource,
    RetrievedItem,
    RSSFeed,
    TopicEditorial,
    TopicPresentation,
)
from rundown.rss import Entry

A, B, C = 'abcdefghijk', 'lmnopqrstuv', '12345678901'
GOOD = 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg'
FEED = b'''<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>Studio Journal</title><link>https://example.com/</link><description>News</description>
<item><guid isPermaLink="false">one</guid><title>A full original headline that is longer than thirty characters</title><link>https://example.com/one</link><author>Ines Okafor</author><description><![CDATA[<p>Important background.</p><p>Ask why now?</p>]]></description><media:thumbnail url="https://cdn.example.com/one.jpg" width="1200" height="630"/></item>
<item><guid isPermaLink="false">two</guid><title>Relative content image</title><link>https://example.com/two</link><description>Body two.</description><media:content url="/img/two.png" medium="image" width="&#178;" height="9999999999999"/></item>
<item><guid isPermaLink="false">three</guid><title>Enclosure image</title><link>https://example.com/three</link><enclosure url="https://cdn.example.com/three.png" type="image/png" length="1"/></item>
<item><guid isPermaLink="false">four</guid><title>Private thumbnail dropped</title><link>https://example.com/four</link><media:thumbnail url="http://127.1/secret.png"/><media:thumbnail url="javascript:alert(1)"/></item>
<item><guid isPermaLink="false">five</guid><title>Empty media address</title><link>https://example.com/five</link><media:thumbnail url=""/><enclosure url="" type="image/png"/></item>
</channel></rss>'''


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(settings, 'retrieval_test_origin', 'http://127.0.0.1:8171')
    monkeypatch.setattr(settings, 'rss_scheduler_enabled', False)
    with TestClient(app) as c:
        yield c


def video(ident, **snippet):
    return {'id': ident, 'snippet': {'title': 'Title ' + ident, 'description': 'Full description',
                                    'channelTitle': 'Frame & Field', 'publishedAt': datetime.now(UTC).isoformat(), **snippet}}


def transport(monkeypatch, ids, videos):
    monkeypatch.setattr(settings, 'retrieval_test_origin', '')
    monkeypatch.setattr(settings, 'youtube_api_key', 'test-only-key')
    def handler(request):
        if request.url.path.endswith('/search'):
            return httpx.Response(200, json={'items': [{'id': {'videoId': i}} for i in ids]})
        assert request.url.params['part'] == 'snippet'
        return httpx.Response(200, json={'items': videos})
    original = httpx.Client
    monkeypatch.setattr(collectors.httpx, 'Client', lambda **kwargs: original(transport=httpx.MockTransport(handler), **kwargs))


def source():
    return RetrievalSource(id='t', name='Test', platform='youtube', query='AI', limit=50, created_at=0, updated_at=0)


def test_youtube_snippet_keeps_creator_and_largest_valid_thumbnail(monkeypatch):
    transport(monkeypatch, [A, B, C], [
        video(A, thumbnails={'default': {'url': GOOD.replace('hq', ''), 'width': 120, 'height': 90},
                             'high': {'url': GOOD, 'width': '480', 'height': 360},
                             'maxres': {'url': 'http://10.0.0.1/internal.jpg', 'width': 1280, 'height': 720}}),
        video(B, thumbnails={'high': {'url': GOOD, 'width': '²', 'height': True}}),
        video(C, thumbnails=['not', 'a', 'dict'], channelTitle='')])
    entries, skipped = collectors.collect(source())
    assert skipped == 0 and [e.identity for e in entries] == ['youtube:' + A, 'youtube:' + B, 'youtube:' + C]
    assert (entries[0].creator, entries[0].thumbnail_url, entries[0].thumbnail_width, entries[0].thumbnail_height) == ('Frame & Field', GOOD, 480, 360)
    assert entries[0].excerpt == 'Full description' and entries[0].media_seconds is None
    assert (entries[1].thumbnail_url, entries[1].thumbnail_width, entries[1].thumbnail_height) == (GOOD, None, None)
    assert entries[2].thumbnail_url is None and entries[2].creator == ''
    assert entries[2].title == 'Title ' + C and 'Full description' in entries[2].body


def test_rss_media_thumbnails_enclosures_and_bad_data():
    entries, warnings = rss.parse_feed(FEED, 'https://example.com/feed.xml')
    assert warnings == [] and all(isinstance(e, Entry) for e in entries)
    one, two, three, four, five = entries
    assert isinstance(one, Entry) and (one.creator, one.thumbnail_url, one.thumbnail_width, one.thumbnail_height) == ('Ines Okafor', 'https://cdn.example.com/one.jpg', 1200, 630)
    assert one.excerpt == 'Important background. Ask why now?' and one.body == 'Important background.\nAsk why now?'
    assert isinstance(two, Entry) and (two.creator, two.thumbnail_url, two.thumbnail_width, two.thumbnail_height) == ('Studio Journal', 'https://example.com/img/two.png', None, None)
    assert isinstance(three, Entry) and three.thumbnail_url == 'https://cdn.example.com/three.png'
    assert isinstance(four, Entry) and four.thumbnail_url is None and four.title == 'Private thumbnail dropped'
    assert isinstance(five, Entry) and five.thumbnail_url is None


@pytest.mark.parametrize('url', [
    'http://127.1/x', 'http://0x7f000001/x', 'http://2130706433/x', 'http://127.0.0.1/x', 'http://localhost/x',
    'http://[::1]/x', 'http://10.0.0.1/x', 'http://169.254.1.1/x', 'https://user:pw@example.com/a.jpg',
    'javascript:alert(1)', 'https://example.com/a b', 'http://example.com:99999/x', 'https://foo.123/x',
    'file:///etc/passwd', 'http://a.local/x', 'http://[2001:db8::1]/x', 'https://example.com\\@evil/x',
    'https://example.com/' + 'x' * 2048, '', None, 42,
])
def test_unsafe_image_urls_rejected(url):
    assert presentation.safe_image_url(url) is None


def test_fixture_origin_only_when_configured(monkeypatch):
    assert presentation.safe_image_url('http://127.0.0.1:8171/thumb.png') is None
    monkeypatch.setattr(settings, 'retrieval_test_origin', 'http://127.0.0.1:8171')
    assert presentation.safe_image_url('http://127.0.0.1:8171/thumb.png') == 'http://127.0.0.1:8171/thumb.png'
    assert presentation.safe_image_url('http://127.0.0.1:8172/thumb.png') is None


@pytest.mark.parametrize('value,expected', [('480', 480), (480, 480), ('0480', 480), ('²', None), ('1' * 5000, None),
                                            (True, None), (0, None), (10001, None), ('12.5', None), (None, None)])
def test_dimension_guarded(value, expected):
    assert presentation.dimension(value) == expected


def entry(**patch):
    base = dict(identity='youtube:' + A, url='https://www.youtube.com/watch?v=' + A, title='Full title about AI innovation and research',
                body='Description only.', published=datetime.now(UTC).isoformat(), truncated=False,
                creator='Frame & Field', thumbnail_url=GOOD, thumbnail_width=480, thumbnail_height=360, excerpt='Description only.')
    return Entry(**{**base, **patch})


def editorial(client, item, **patch):
    body = {'revision': item['editorial']['revision'], 'saved': item['editorial']['saved'], 'note': item['editorial']['note'], **patch}
    return client.put('/inbox/' + item['id'] + '/editorial', json=body)


def test_import_readback_editorial_conflicts_duplicates_and_live_preservation(client, monkeypatch):
    client.put('/rundown/schedule', json={'revision': 0, 'topics': [{'text': 'On air', 'duration': 3600}]})
    client.post('/rundown/control', json={'revision': 1, 'action': 'play'})
    with db.session() as d:
        clock = d.get(show.ShowClock, 1)
        assert clock
        before = clock.model_dump()
    monkeypatch.setattr(collectors, 'collect', lambda _: ([entry()], 0))
    s = client.post('/retrieval', json={'name': 'AI research', 'platform': 'youtube', 'query': 'AI'}).json()
    run = client.post('/retrieval/' + s['id'] + '/import', json={'revision': s['revision'], 'request_id': str(uuid4())}).json()
    assert run['status'] == 'succeeded' and run['created'] == 1
    item = client.get('/inbox').json()['items'][0]
    assert item['presentation'] == {'provider': 'youtube', 'creator': 'Frame & Field', 'excerpt': 'Description only.',
                                    'thumbnail': {'url': GOOD, 'width': 480, 'height': 360}, 'media_seconds': None,
                                    'state': 'ready', 'reason': None, 'fetched_at': item['presentation']['fetched_at']}
    assert item['editorial'] == {'revision': 0, 'saved': False, 'note': '', 'updated_at': None}
    assert item['source']['original_title'] == entry().title and item['text'] == entry().title[:30]
    assert client.get('/inbox/' + item['id']).json() == item

    # Bookmark and note: own revision namespace, topic/source untouched.
    marked = editorial(client, item, saved=True, note='Ask about the long take').json()
    assert marked['editorial']['revision'] == 1 and marked['editorial']['saved'] and marked['editorial']['note'] == 'Ask about the long take'
    assert marked['revision'] == item['revision'] and marked['notes'] == item['notes'] and marked['source'] == item['source']
    assert marked['topic'] == item['topic'] and marked['updated_at'] == item['updated_at']
    assert client.get('/inbox/' + item['id']).json() == marked

    # Stale editorial write: 409, stored note unchanged.
    stale = editorial(client, item, saved=False, note='Older screen')
    assert stale.status_code == 409 and 'kept' in stale.json()['detail']
    assert client.get('/inbox/' + item['id']).json() == marked
    # Legacy topic edit with the topic revision still succeeds: the namespaces are separate.
    edited = client.put('/inbox/' + item['id'], json={'revision': item['revision'], 'text': 'Editorial title', 'notes': 'My notes', 'duration': 90, 'source_url': item['source_url']}).json()
    assert edited['revision'] == item['revision'] + 1 and edited['editorial'] == marked['editorial']
    assert editorial(client, {**edited, 'editorial': {**edited['editorial'], 'revision': item['revision'] + 1}}, note='x').status_code == 409

    # Duplicate import: nothing clobbered.
    with db.session() as d:
        for r in d.exec(select(__import__('rundown.models', fromlist=['RetrievalRun']).RetrievalRun)).all():
            r.started_at -= 3
            d.add(r)
        d.commit()
    monkeypatch.setattr(collectors, 'collect', lambda _: ([entry(creator='Changed', thumbnail_url=None, excerpt='Changed')], 0))
    again = client.post('/retrieval/' + s['id'] + '/import', json={'revision': s['revision'], 'request_id': str(uuid4())}).json()
    assert again['created'] == 0 and again['duplicates'] == 1
    assert client.get('/inbox/' + item['id']).json() == edited
    with db.session() as d:
        clock = d.get(show.ShowClock, 1)
        assert clock and clock.model_dump() == before
        assert len(d.exec(select(TopicPresentation)).all()) == 1
    state = client.get('/rundown/state').json()
    assert state['topics'][0]['text'] == 'On air' and not state['paused']


def test_backfill_only_prior_imports_and_partial_state(client, monkeypatch):
    monkeypatch.setattr(collectors, 'collect', lambda _: ([entry(thumbnail_url=None, thumbnail_width=None, thumbnail_height=None)], 0))
    s = client.post('/retrieval', json={'name': 'AI research', 'platform': 'youtube', 'query': 'AI'}).json()
    client.post('/retrieval/' + s['id'] + '/import', json={'revision': s['revision'], 'request_id': str(uuid4())})
    item = client.get('/inbox').json()['items'][0]
    assert item['presentation']['state'] == 'partial' and item['presentation']['thumbnail'] is None and item['presentation']['reason']
    # An older import with no presentation row gets one on the next duplicate import; a manual idea never does.
    manual = client.post('/inbox', json={'text': 'Manual', 'duration': 120, 'source_url': 'https://www.youtube.com/watch?v=' + B}).json()
    with db.session() as d:
        d.connection().execute(text('DELETE FROM topicpresentation'))
        d.commit()
    monkeypatch.setattr(collectors, 'collect', lambda _: ([entry(), entry(identity='youtube:' + B, url='https://www.youtube.com/watch?v=' + B)], 0))
    with db.session() as d:
        for r in d.exec(select(__import__('rundown.models', fromlist=['RetrievalRun']).RetrievalRun)).all():
            r.started_at -= 3
            d.add(r)
        d.commit()
    again = client.post('/retrieval/' + s['id'] + '/import', json={'revision': s['revision'], 'request_id': str(uuid4())}).json()
    assert again['duplicates'] == 2 and again['created'] == 0
    assert client.get('/inbox/' + item['id']).json()['presentation']['thumbnail']['url'] == GOOD
    assert client.get('/inbox/' + manual['id']).json() == manual


def test_rss_import_stores_presentation(client, monkeypatch):
    monkeypatch.setattr(rss, 'fetch_feed', lambda url: (FEED, url))
    feed = client.post('/feeds', json={'name': 'Journal', 'url': 'https://example.com/feed.xml', 'default_duration': 120}).json()
    result = client.post('/feeds/' + feed['id'] + '/import', json={'revision': feed['revision']}).json()
    assert result['created'] == 5
    by_url = {i['source_url']: i for i in client.get('/inbox').json()['items']}
    one = by_url['https://example.com/one']
    assert one['presentation']['provider'] == 'rss' and one['presentation']['creator'] == 'Ines Okafor'
    assert one['presentation']['thumbnail'] == {'url': 'https://cdn.example.com/one.jpg', 'width': 1200, 'height': 630}
    assert one['source']['body_text'] == 'Important background.\nAsk why now?' and one['notes'].startswith('Feed: Journal')
    assert by_url['https://example.com/four']['presentation']['state'] == 'partial'


@pytest.mark.parametrize('body', [
    {'revision': 0, 'saved': True}, {'revision': 0, 'saved': 'true', 'note': ''}, {'revision': 0.0, 'saved': True, 'note': ''},
    {'revision': -1, 'saved': True, 'note': ''}, {'revision': 0, 'saved': True, 'note': 'x' * 10001},
    {'revision': 0, 'saved': True, 'note': 'a\x00b'}, {'revision': 0, 'saved': True, 'note': '', 'extra': 1},
    {'revision': 0, 'saved': True, 'note': None},
])
def test_editorial_validation_is_atomic(client, body):
    item = client.post('/inbox', json={'text': 'Idea', 'duration': 120}).json()
    assert client.put('/inbox/' + item['id'] + '/editorial', json=body).status_code == 422
    assert client.get('/inbox/' + item['id']).json() == item
    assert client.put('/inbox/missing/editorial', json={'revision': 0, 'saved': True, 'note': ''}).status_code == 404
    assert client.patch('/inbox/' + item['id'] + '/editorial', json={'revision': 0, 'saved': True, 'note': 'ok'}).json()['editorial']['saved']


def test_old_schema_upgrades_additively(client):
    """A database created before this slice keeps every row and gains only the new tables."""
    engine = db._engine
    old = [t for name, t in SQLModel.metadata.tables.items() if name not in {'topicpresentation', 'topiceditorial'}]
    SQLModel.metadata.drop_all(engine)
    SQLModel.metadata.create_all(engine, tables=old)
    assert set(inspect(engine).get_table_names()) & {'topicpresentation', 'topiceditorial'} == set()
    with db.session() as d:
        d.add(RSSFeed(id='f', name='Old feed', url='https://example.com/old.xml', created_at=1, updated_at=1))
        d.add(InboxTopic(id='old', text='Old import', duration=120, notes='Feed: Old feed\n\nOriginal title: Old', source_url='https://example.com/old', created_at=1, updated_at=1))
        d.add(InboxSource(inbox_topic_id='old', feed_id='f', feed_name='Old feed', original_title='Old headline', body_text='Old body', imported_at=1))
        d.commit()
    db.init_db()
    names = set(inspect(engine).get_table_names())
    assert {'topicpresentation', 'topiceditorial', 'inboxtopic', 'inboxsource'} <= names
    item = client.get('/inbox/old').json()
    assert item['presentation'] is None and item['editorial'] == {'revision': 0, 'saved': False, 'note': '', 'updated_at': None}
    assert item['source']['original_title'] == 'Old headline' and item['notes'].startswith('Feed: Old feed')
    marked = editorial(client, item, saved=True, note='Still works').json()
    assert marked['editorial']['revision'] == 1 and marked['notes'] == item['notes']
    with db.session() as d:
        assert d.get(TopicEditorial, 'old') is not None
        assert d.exec(select(RetrievedItem)).all() == []
