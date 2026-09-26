"""Uploads: bytes decide the type, files live under the isolated assets dir by
opaque id, rejected uploads leave no rows and no files, downloads are byte-identical."""

import hashlib
import struct
import zlib

import pytest
from fastapi.testclient import TestClient
from sqlmodel import select

from rundown import attachments, db
from rundown.config import settings
from rundown.main import app
from rundown.models import Attachment, InboxTopic, TopicCapture, TopicEditorial


@pytest.fixture
def client():
    with TestClient(app) as client:
        yield client


def png(width=4, height=3):
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
    raw = b''.join(b'\x00' + b'\x10\x20\x30' * width for _ in range(height))
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))


def jpeg(width=6, height=5):
    sof = b'\xff\xc0' + struct.pack('>H', 11) + b'\x08' + struct.pack('>HH', height, width) + b'\x01\x01\x11\x00'
    return b'\xff\xd8\xff\xe0' + struct.pack('>H', 16) + b'JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00' + sof + b'\xff\xda\x00\x08\x01\x01\x00\x00\x3f\x00\xff\xd9'


PDF = b'%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n'


def upload(client, data, filename, content_type, title='Uploaded thing', **params):
    headers = {'Content-Type': content_type} if content_type else {}
    return client.post('/attachments', params={'title': title, 'filename': filename, **params}, content=data, headers=headers)


def files():
    return sorted(p.name for p in settings.assets_dir.iterdir()) if settings.assets_dir.exists() else []


def rows():
    with db.session() as d:
        return (len(d.exec(select(InboxTopic)).all()), len(d.exec(select(TopicCapture)).all()),
                len(d.exec(select(TopicEditorial)).all()), len(d.exec(select(Attachment)).all()))


def test_each_supported_type_round_trips_byte_identical(client):
    cases = [
        (png(), 'cover.png', 'image/png', 'image/png', 'cover', (4, 3)),
        (jpeg(), 'photo.JPEG', 'image/jpeg', 'image/jpeg', 'cover', (6, 5)),
        (PDF, 'brief.pdf', 'application/pdf', 'application/pdf', 'document', (None, None)),
        ('Plain notes\nwith ünïcode'.encode(), 'notes.txt', 'text/plain', 'text/plain', 'document', (None, None)),
        (b'# Heading\n\n- item', 'outline.md', '', 'text/markdown', 'document', (None, None)),
    ]
    for data, name, declared, expected, role, dims in cases:
        r = upload(client, data, name, declared, title=f'Topic {name}')
        assert r.status_code == 201, (name, r.text)
        item = r.json()
        [att] = item['capture']['attachments']
        assert (att['media_type'], att['role'], (att['width'], att['height']), att['size']) == (expected, role, dims, len(data))
        assert att['sha256'] == hashlib.sha256(data).hexdigest() and att['filename'] == name
        assert item['capture']['kind'] == 'upload' and item['text'] == f'Topic {name}' and item['editorial']['saved'] is True
        assert item['capture']['source_text'] == (data.decode() if expected.startswith('text/') else '')
        served = client.get(att['url'])
        assert served.status_code == 200 and served.content == data
        assert served.headers['x-content-type-options'] == 'nosniff'
        if role == 'cover':
            assert served.headers['content-type'] == expected and served.headers['content-disposition'].startswith('inline;')
            forced = client.get(att['url'] + '?download=1')
            assert forced.headers['content-disposition'].startswith('attachment;') and forced.content == data
        else:
            assert served.headers['content-disposition'].startswith('attachment;')
            assert served.headers['content-type'].startswith('text/plain' if expected.startswith('text/') else 'application/pdf')
        stored = attachments.stored_path(att['id'], expected)
        assert stored.parent == settings.assets_dir and stored.read_bytes() == data
    assert len(files()) == 5 and rows() == (5, 5, 5, 5)
    assert client.get('/inbox').json()['items'][0]['capture']['attachments'][0]['url'].startswith('/attachments/')
    assert client.get('/attachments/' + 'f' * 32).status_code == 404
    assert client.get('/attachments/../etc/passwd').status_code in {404, 422}


@pytest.mark.parametrize('data, name, declared, why', [
    (b'x' * (1024 * 1024 + 1), 'big.txt', 'text/plain', '1 MB'),
    (b'<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'vector.svg', 'image/svg+xml', 'PNG, JPEG'),
    (b'<html><script>alert(1)</script></html>', 'page.html', 'text/html', 'PNG, JPEG'),
    (b'\x89PNG\r\n\x1a\nnot really', 'bad.png', 'image/png', 'malformed'),
    (b'\xff\xd8\xff\xe0\x00\x02', 'bad.jpg', 'image/jpeg', 'frame header'),
    (b'%PDF-1.7 no trailer', 'bad.pdf', 'application/pdf', 'incomplete'),
    (b'GIF89a', 'anim.gif', 'image/gif', 'PNG, JPEG'),
    (b'binary\x00text', 'weird.txt', 'text/plain', 'binary'),
    (b'\xff\xfe\xfd', 'latin.txt', 'text/plain', 'UTF-8'),
    (('x' * 50001).encode(), 'long.md', 'text/markdown', '50000'),
    (PDF, 'brief.pdf', 'image/png', 'looks like'),
    (b'', 'empty.txt', 'text/plain', 'empty'),
])
def test_rejected_uploads_leave_no_rows_or_files(client, data, name, declared, why):
    r = upload(client, data, name, declared)
    assert r.status_code in {413, 422}, r.text
    assert why in r.json()['detail']
    assert files() == [] and rows() == (0, 0, 0, 0)


def test_dimension_bounds_and_title_rules(client):
    huge = png()[:16] + struct.pack('>II', 6000, 6000) + png()[24:]
    r = upload(client, huge, 'huge.png', 'image/png')
    assert r.status_code == 422 and 'million pixels' in r.json()['detail']
    long_title = 'A headline that is far too long for the live label limit'
    assert upload(client, png(), 'a.png', 'image/png', title=long_title).status_code == 422
    r = upload(client, png(), 'a.png', 'image/png', title=long_title, label='Short label')
    assert r.status_code == 201 and r.json()['text'] == 'Short label' and r.json()['capture']['display_title'] == long_title
    assert upload(client, png(), 'a.png', 'image/png', title='ok', label='x' * 31).status_code == 422
    assert upload(client, png(), 'a.png', 'image/png', title='   ').status_code == 422
    assert files().__len__() == 1 and rows() == (1, 1, 1, 1)


def test_client_filename_is_display_only(client):
    r = upload(client, PDF, '../../etc/passwd\x00.pdf', 'application/pdf')
    assert r.status_code == 201
    att = r.json()['capture']['attachments'][0]
    assert att['filename'] == 'passwd.pdf' and '/' not in att['filename']
    assert files() == [att['id'] + '.pdf']
    assert not (settings.assets_dir.parent / 'etc').exists()
    r = upload(client, PDF, 'C:\\Users\\me\\..\\deck.pdf', 'application/pdf')
    assert r.json()['capture']['attachments'][0]['filename'] == 'deck.pdf'
    r = upload(client, PDF, '', 'application/pdf')
    assert r.json()['capture']['attachments'][0]['filename'] == 'upload'
    assert len(files()) == 3


def test_failed_commit_removes_the_file(client, monkeypatch):
    def boom(*_args, **_kwargs):
        raise RuntimeError('disk on fire')
    monkeypatch.setattr(attachments, 'full_detail', boom)
    with pytest.raises(RuntimeError):
        upload(client, png(), 'a.png', 'image/png')
    assert files() == [] and rows() == (0, 0, 0, 0)


def test_display_filename_helper():
    assert attachments.display_filename('  a/b/../c.txt ') == 'c.txt'
    assert attachments.display_filename('..') == 'upload'
    assert attachments.display_filename('x' * 500).__len__() == 120
    assert attachments.display_filename('tab\there.md') == 'tabhere.md'
