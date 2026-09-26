"""Additive schema proof: build a database with the pre-slice schema (every table
except topicpresentation/topiceditorial), seed rows, boot the app on it, verify."""
import json
import os
import sqlite3
import sys
from pathlib import Path

O = Path('/private/tmp/rundown-discover-implementation')
dst = O / 'old-schema.db'
for suffix in ['', '-journal', '-wal', '-shm']:
    if (O / f'old-schema.db{suffix}').exists():
        (O / f'old-schema.db{suffix}').unlink()
os.environ.update({'DB_PATH': str(dst), 'RSS_SCHEDULER_ENABLED': 'false', 'ANTHROPIC_API_KEY': '', 'YOUTUBE_API_KEY': '',
                   'REDDIT_CLIENT_SECRET': '', 'REDDIT_CLIENT_ID': '', 'RAW_CACHE_DIR': str(O / 'raw'), 'LOGS_DIR': str(O / 'logs')})
sys.path.insert(0, '/Users/rei/2026/Rundown/apps/api')
from sqlmodel import Session, SQLModel, create_engine  # noqa: E402

from rundown import models  # noqa: E402,F401
from rundown.show import ShowClock  # noqa: E402,F401

NEW = {'topicpresentation', 'topiceditorial'}
engine = create_engine(f'sqlite:///{dst}')
old_tables = [t for name, t in SQLModel.metadata.tables.items() if name not in NEW]
SQLModel.metadata.create_all(engine, tables=old_tables)
with Session(engine) as s:
    s.add(models.RSSFeed(id='f', name='Old feed', url='https://example.com/old.xml', created_at=1, updated_at=1))
    s.add(models.InboxTopic(id='old-rss', text='Old RSS import', duration=120, notes='Feed: Old feed\n\nOriginal title: Old headline', source_url='https://example.com/old', created_at=1, updated_at=2))
    s.add(models.InboxSource(inbox_topic_id='old-rss', feed_id='f', feed_name='Old feed', original_title='Old headline', body_text='Old body', imported_at=1))
    s.add(models.RetrievalSource(id='r', name='Old search', platform='youtube', query='x', created_at=1, updated_at=1))
    s.add(models.InboxTopic(id='old-yt', text='Old YouTube import', duration=120, notes='Youtube · Old search\nOriginal title: Old video', source_url='https://www.youtube.com/watch?v=abcdefghijk', created_at=1, updated_at=3))
    s.add(models.RetrievedItem(id='youtube:abcdefghijk', inbox_topic_id='old-yt', platform='youtube', feed_id='r', feed_name='Old search', url='https://www.youtube.com/watch?v=abcdefghijk', original_title='Old video', body_text='Video description only; transcript and video have not been retrieved.\nChannel/community: Old channel\n\nOld description', published_at='2026-09-01T00:00:00+00:00', imported_at=1))
    s.add(models.InboxTopic(id='manual', text='Manual idea', duration=90, notes='Mine', source_url='', created_at=1, updated_at=1))
    s.add(models.SavedShow(id='s', name='Old show', topics_json='[{"id":"t","text":"x","duration":60,"notes":""}]', created_at=1, updated_at=1))
    s.commit()
engine.dispose()


def snapshot(path):
    con = sqlite3.connect(path)
    tables = sorted(r[0] for r in con.execute("select name from sqlite_master where type='table'"))
    counts = {t: con.execute(f'select count(*) from "{t}"').fetchone()[0] for t in tables}
    columns = {t: [c[1] for c in con.execute(f'pragma table_info("{t}")')] for t in tables}
    rows = {t: con.execute(f'select * from "{t}" order by 1').fetchall() for t in tables}
    con.close()
    return tables, counts, columns, rows


before = snapshot(dst)
assert not NEW & set(before[0]), before[0]
from fastapi.testclient import TestClient  # noqa: E402

from rundown.main import app  # noqa: E402

with TestClient(app) as client:  # lifespan runs init_db() exactly as uvicorn would
    items = client.get('/inbox').json()['items']
    by_id = {i['id']: i for i in items}
    readable = {k: (v['presentation'], v['editorial']) for k, v in by_id.items()}
    r = client.put('/inbox/old-yt/editorial', json={'revision': 0, 'saved': True, 'note': 'upgrade proof'})
    editorial_ok = r.status_code == 200 and r.json()['editorial']['revision'] == 1 and r.json()['notes'] == by_id['old-yt']['notes'] and r.json()['revision'] == by_id['old-yt']['revision'] == 1
    stale = client.put('/inbox/old-yt/editorial', json={'revision': 0, 'saved': False, 'note': 'stale'}).status_code
after = snapshot(dst)
new_tables = sorted(set(after[0]) - set(before[0]))
old_rows_intact = all(after[3][t] == before[3][t] for t in before[0])
old_columns_intact = all(after[2][t] == before[2][t] for t in before[0])
out = {'db': str(dst), 'tables_before': len(before[0]), 'tables_after': len(after[0]), 'new_tables': new_tables,
       'row_counts_before': {t: c for t, c in before[1].items() if c}, 'row_counts_after': {t: c for t, c in after[1].items() if c},
       'old_rows_byte_identical': old_rows_intact, 'old_columns_unchanged': old_columns_intact,
       'inbox_items_readable': len(items), 'presentation_editorial_per_item': readable,
       'editorial_write_on_old_row_ok': editorial_ok, 'stale_editorial_status': stale}
json.dump(out, open(O / 'upgrade-check.json', 'w'), indent=1)
ok = new_tables == ['topiceditorial', 'topicpresentation'] and old_rows_intact and old_columns_intact and editorial_ok and stale == 409 and len(items) == 3 \
    and all(p is None and e == {'revision': 0, 'saved': False, 'note': '', 'updated_at': None} for p, e in readable.values())
print(json.dumps(out, indent=1))
print('UPGRADE', 'PASS' if ok else 'FAIL')
sys.exit(0 if ok else 1)
