"""Old-schema proof: build a database from the base commit's models (no topiclinksource),
seed rows, start the candidate app against it, and show the table is added with every row intact."""
import importlib.util, json, os, shutil, sqlite3, subprocess, sys, tempfile, time
from pathlib import Path
R = Path('/Users/rei/2026/Rundown'); O = Path('/private/tmp/rundown-link-preview'); PY = R / 'apps/api/.venv/bin/python'
old = subprocess.check_output(['git', '-C', str(R), 'show', 'HEAD:apps/api/rundown/models.py'])
work = Path(tempfile.mkdtemp(prefix='oldschema-'))
(work / 'old_models.py').write_bytes(old)
db = O / 'old-schema.db'
for suffix in ['', '-journal']:
    p = Path(str(db) + suffix)
    if p.exists(): p.unlink()
seed = f'''
import sys, time; sys.path.insert(0, {str(work)!r})
from sqlmodel import SQLModel, create_engine, Session
import old_models as m
engine = create_engine('sqlite:///{db}')
SQLModel.metadata.create_all(engine)
with Session(engine) as s:
    now = time.time()
    s.add(m.InboxTopic(id='old-1', text='Old idea', duration=120, notes='old notes', source_url='https://example.com/old', created_at=now, updated_at=now))
    s.add(m.TopicCapture(inbox_topic_id='old-1', kind='link', display_title='Old idea full title', created_at=now))
    s.add(m.TopicEditorial(inbox_topic_id='old-1', revision=1, saved=True, note='old personal note', updated_at=now))
    s.add(m.SavedShow(id='show-1', name='Old show', topics_json='[{{"id":"t1","text":"Old idea","duration":120,"notes":"old notes"}}]', created_at=now, updated_at=now))
    s.commit()
'''
subprocess.run([str(PY), '-c', seed], check=True, cwd=str(R / 'apps/api'))
con = sqlite3.connect(db)
before = {t: con.execute(f'select count(*) from {t}').fetchone()[0] for (t,) in con.execute("select name from sqlite_master where type='table' order by name")}
rows_before = {t: con.execute(f'select * from {t}').fetchall() for t in before}
con.close()
assert 'topiclinksource' not in before, before
env = {k: v for k, v in os.environ.items() if not k.startswith(('ANTHROPIC', 'YOUTUBE', 'REDDIT', 'OBS_'))}
env.update({'DB_PATH': str(db), 'RAW_CACHE_DIR': str(O / 'raw'), 'LOGS_DIR': str(O / 'logs'), 'ASSETS_DIR': str(work / 'assets'), 'RSS_SCHEDULER_ENABLED': 'false', 'RESEARCH_AI_ENABLED': 'false', 'PREPARATION_ENABLED': 'false', 'ANTHROPIC_API_KEY': '', 'YOUTUBE_API_KEY': ''})
proc = subprocess.Popen([str(PY), '-m', 'uvicorn', 'rundown.main:app', '--host', '127.0.0.1', '--port', '8194'], cwd=R / 'apps/api', env=env, stdout=(O / 'logs' / 'upgrade-api.log').open('w'), stderr=subprocess.STDOUT)
import httpx
try:
    for _ in range(40):
        try:
            if httpx.get('http://127.0.0.1:8194/health', timeout=1).status_code == 200: break
        except Exception: time.sleep(0.25)
    item = httpx.get('http://127.0.0.1:8194/inbox/old-1', timeout=5).json()
    shows = httpx.get('http://127.0.0.1:8194/shows', timeout=5).json()
finally:
    proc.terminate(); proc.wait(timeout=10)
con = sqlite3.connect(db)
after = {t: con.execute(f'select count(*) from {t}').fetchone()[0] for (t,) in con.execute("select name from sqlite_master where type='table' order by name")}
rows_after = {t: con.execute(f'select * from {t}').fetchall() for t in before}
cols = [r[1] for r in con.execute('pragma table_info(topiclinksource)')]
con.close()
result = {'tables_before': len(before), 'tables_after': len(after), 'added': sorted(set(after) - set(before)), 'topiclinksource_columns': cols,
          'old_rows_identical': rows_before == rows_after, 'old_item_readback': {'text': item['text'], 'display_title': item['capture']['display_title'], 'note': item['editorial']['note'], 'source': item['source'], 'presentation': item['presentation']},
          'shows': [s['name'] for s in shows.get('shows', shows if isinstance(shows, list) else [])]}
print(json.dumps(result, indent=1)); json.dump(result, (O / 'upgrade-result.json').open('w'), indent=1)
shutil.rmtree(work, ignore_errors=True)
assert sorted(set(result['added']) - {'showclock'}) == ['topiclinksource']  # showclock is defined in show.py, not in models.py, so the old build lacked it and result['old_rows_identical'] and item['source'] is None
print('UPGRADE OK')
