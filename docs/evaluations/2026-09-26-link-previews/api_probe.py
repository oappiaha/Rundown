"""Realistic HTTP probes of the running API (8193) against the fixture (8192). Writes api-results.json."""
import json, time, httpx
O = '/private/tmp/rundown-link-preview'; F = 'http://127.0.0.1:8192'
api = httpx.Client(base_url='http://127.0.0.1:8193', timeout=30)
out = {'previews': [], 'captures': [], 'checks': []}
def check(name, ok, detail=None):
    out['checks'].append({'name': name, 'ok': bool(ok), 'detail': detail}); print(('PASS ' if ok else 'FAIL ') + name, '' if detail is None else json.dumps(detail, default=str)[:220], flush=True)
def preview(url):
    time.sleep(2.1)
    r = api.post('/link-previews/preview', json={'url': url}); body = r.json()
    rec = {'url': url, 'status': r.status_code, 'body': {k: (v[:24] + '…' if k == 'token' else v) for k, v in body.items()} if isinstance(body, dict) else body}
    out['previews'].append(rec); return r.status_code, body
before = api.get('/inbox').json()['items']; live0 = api.get('/rundown/state').json(); plan0 = api.get('/plans').json()['plans'][0]
# 1 article
s, a = preview(F + '/articles/offwhite.html')
check('article preview 200 with first og:image dims', s == 200 and a['thumbnail'] == {'url': F + '/thumbs/offwhite.png', 'width': 1200, 'height': 630} and a['creator'] == 'Tomas Reyes' and a['site_name'] == 'Surface Notes', a.get('thumbnail'))
check('body/script/style og:title ignored, og:title beats <title>', a['title'].startswith('Off-white is a decision'), a['title'])
check('preview creates no inbox row', len(api.get('/inbox').json()['items']) == len(before))
# redirect keeps entered URL
s, r = preview(F + '/articles/redirect')
check('redirect: entered url preserved, resolved differs', s == 200 and r['source_url'] == F + '/articles/redirect' and r['resolved_url'] == F + '/articles/offwhite.html?from=redirect', {'source_url': r.get('source_url'), 'resolved_url': r.get('resolved_url')})
# long headline + relative image + mixed case
s, l = preview(F + '/articles/long-headline.html')
check('long headline kept in full, relative image resolved, no dims', s == 200 and len(l['title']) > 200 and l['thumbnail'] == {'url': F + '/thumbs/cover-rel.png', 'width': None, 'height': None} and l['description'].startswith('Relative image'), {'len': len(l.get('title', '')), 'thumb': l.get('thumbnail')})
# body-only
s, b = preview(F + '/articles/body-only.html')
check('body-only og metas ignored: plain <title>, no image/description', s == 200 and b['title'] == 'Body-only page: plain title only' and b['thumbnail'] is None and b['description'] == '', b)
# xss page
s, x = preview(F + '/articles/xss.html')
check('escaped/tag-like metadata reduced to plain text; javascript: image dropped; twitter:image fallback', s == 200 and 'Quotes "and"' in x['title'] and '<script>' not in x['title'] and 'alert' not in x['title'] and x['thumbnail']['url'] == F + '/thumbs/second.png' and '<img' not in x['site_name'] and x['description'] == 'Description with tags & entities', {'title': x.get('title'), 'site': x.get('site_name'), 'desc': x.get('description'), 'thumb': x.get('thumbnail')})
# oversize
s, o = preview(F + '/articles/oversize.html')
check('oversize page with head in cap: truncated preview', s == 200 and o['truncated'] is True and o['title'] == 'Oversize page headline', o.get('truncated'))
s, o2 = preview(F + '/articles/oversize-late.html')
check('oversize page with metadata beyond cap: 502 clear message', s == 502, o2)
# failures
for name, expect in [('forbidden', '403'), ('ratelimited', '429'), ('missing', '404'), ('server-error', '503'), ('notes.json', 'not an HTML page'), ('image.png', 'not an HTML page'), ('malformed.html', 'no title'), ('no-metadata.html', 'no title'), ('private-redirect', 'public internet address'), ('loopback-redirect', 'public internet address'), ('loop', 'too many times'), ('bad-length.html', 'invalid length'), ('gzip.html', 'compressed')]:
    s, e = preview(F + '/articles/' + name)
    detail = e.get('detail', '') if isinstance(e, dict) else ''
    check(f'{name}: 502 with "{expect}" and no remote body', s == 502 and expect in detail and 'BODY' not in detail and 'FORBIDDEN' not in detail, detail)
s, e = preview(F + '/articles/slow.html')
check('slow page: timed out within cap', s == 502 and 'timed out' in e.get('detail', ''), e)
# unsupported / invalid
for url, code in [('https://x.com/user/status/123', 422), ('https://www.tiktok.com/@user', 422), ('ftp://example.com/x', 422), ('http://user:pw@example.com/x', 422), ('http://127.0.0.1:8192/articles/offwhite.html\\', 422), ('http://10.0.0.1/secret', 502), ('http://127.0.0.1:1/secret', 502), ('http://localhost:8192/articles/offwhite.html', 502)]:
    time.sleep(2.1); r = api.post('/link-previews/preview', json={'url': url}); out['previews'].append({'url': url, 'status': r.status_code, 'body': r.json()})
    check(f'{url[:40]} -> {code}', r.status_code == code, r.json())
# tiktok
s, t = preview('https://www.tiktok.com/@synthetic.maker/video/7000000000000000001?utm=x')
check('tiktok preview: caption, creator, portrait dims retained', s == 200 and t['kind'] == 'tiktok' and t['creator'] == 'synthetic.maker' and t['thumbnail'] == {'url': F + '/thumbs/portrait.png', 'width': 360, 'height': 640} and t['resolved_url'] == 'https://www.tiktok.com/@synthetic.maker/video/7000000000000000001' and t['source_url'].endswith('?utm=x'), t.get('thumbnail'))
for ident, expect in [('2', 'denied'), ('3', 'rate limit'), ('5', 'caption'), ('7', 'could not be read'), ('8', 'caption')]:
    s, e = preview(f'https://www.tiktok.com/@u/video/700000000000000000{ident}')
    check(f'tiktok {ident}: 502 "{expect}"', s == 502 and expect in e.get('detail', ''), e)
s, h = preview('https://www.tiktok.com/@u/video/7000000000000000004')
check('tiktok huge caption bounded: title<=1000, description<=6000, truncated', s == 200 and len(h['title']) <= 1000 and len(h['description']) <= 6000 and h['truncated'] is True, {'t': len(h['title']), 'd': len(h['description'])})
s, p6 = preview('https://www.tiktok.com/@u/video/7000000000000000006')
check('tiktok private thumbnail host dropped, caption kept', s == 200 and p6['thumbnail'] is None and p6['title'].startswith('Private thumbnail'), p6.get('thumbnail'))
# rate limit
preview(F + '/articles/offwhite.html'); r1 = api.post('/link-previews/preview', json={'url': F + '/articles/offwhite.html'}); r2 = api.post('/link-previews/preview', json={'url': F + '/articles/long-headline.html'})
check('cached repeat 200, then immediate different url 429', r1.status_code == 200 and r2.status_code == 429, r2.json())
# capture with token
tok = a['token']; entered = a['source_url']
r = api.post('/inbox/capture', json={'kind': 'link', 'title': 'My edited headline', 'note': 'my note', 'source_url': entered, 'preview': tok}); c = r.json(); out['captures'].append({'case': 'article ok', 'status': r.status_code, 'body': c})
check('capture with token 201: source article + presentation + user title/note kept', r.status_code == 201 and c['source']['kind'] == 'article' and c['source']['original_title'].startswith('Off-white') and c['capture']['display_title'] == 'My edited headline' and c['editorial']['note'] == 'my note' and c['presentation']['thumbnail']['width'] == 1200 and c['source_url'] == entered and c['source']['entered_url'] == entered and c['presentation']['creator'] == 'Tomas Reyes', {k: c.get(k) for k in ('source', 'presentation')})
rb = api.get(f"/inbox/{c['id']}").json()
check('readback GET equals create response source/presentation', rb['source'] == c['source'] and rb['presentation'] == c['presentation'])
# swapped url
r = api.post('/inbox/capture', json={'kind': 'link', 'title': 'Swap', 'note': '', 'source_url': F + '/articles/redirect', 'preview': tok})
check('token bound to entered url: swapped url 409, nothing saved', r.status_code == 409 and 'different link' in r.json()['detail'] and len(api.get('/inbox').json()['items']) == len(before) + 1, r.json())
# query string difference
r = api.post('/inbox/capture', json={'kind': 'link', 'title': 'Swap', 'note': '', 'source_url': entered + '?x=1', 'preview': tok})
check('query-string change also 409', r.status_code == 409)
# tampered / malformed tokens
for bad in [tok[:-2] + 'AA', tok.split('.')[0] + '.é', 'nonsense', tok + '.x']:
    r = api.post('/inbox/capture', json={'kind': 'link', 'title': 'Bad', 'note': '', 'source_url': entered, 'preview': bad})
    check(f'malformed token -> 409 (not 500): {bad[-6:]!r}', r.status_code == 409, r.json())
r = api.post('/inbox/capture', json={'kind': 'write', 'title': 'Write', 'note': '', 'preview': tok})
check('preview with kind write -> 422', r.status_code == 422)
r = api.post('/inbox/capture', json={'kind': 'link', 'title': 'Manual after failure', 'note': 'kept', 'source_url': F + '/articles/forbidden'})
check('manual save without token still 201 with null source/presentation', r.status_code == 201 and r.json()['source'] is None and r.json()['presentation'] is None)
out['manual_id'] = r.json()['id']
# tiktok capture
r = api.post('/inbox/capture', json={'kind': 'link', 'title': t['title'][:60], 'label': 'Kerning sign fix', 'note': 'portrait check', 'source_url': t['source_url'], 'preview': t['token']}); ct = r.json(); out['captures'].append({'case': 'tiktok ok', 'status': r.status_code, 'body': ct})
check('tiktok capture: source tiktok, creator, portrait 360x640 persisted', r.status_code == 201 and ct['source']['kind'] == 'tiktok' and ct['presentation']['thumbnail'] == {'url': F + '/thumbs/portrait.png', 'width': 360, 'height': 640} and ct['presentation']['creator'] == 'synthetic.maker' and ct['source']['feed_name'] == 'TikTok' and ct['text'] == 'Kerning sign fix', ct.get('presentation'))
# long headline capture: full headline retained, title bounded by user
r = api.post('/inbox/capture', json={'kind': 'link', 'title': l['title'][:200].rsplit(' ', 1)[0], 'label': 'Coastal archive', 'note': '', 'source_url': l['source_url'], 'preview': l['token']}); cl = r.json()
check('long headline: 200-char title stored, full fetched headline in source.original_title', r.status_code == 201 and len(cl['capture']['display_title']) <= 200 and cl['source']['original_title'] == l['title'] and len(l['title']) > 200, {'title_len': len(cl['capture']['display_title']), 'src_len': len(cl['source']['original_title'])})
out['ids'] = {'article': c['id'], 'tiktok': ct['id'], 'long': cl['id']}
# preservation
live1 = api.get('/rundown/state').json(); plan1 = api.get(f"/plans/{plan0['id']}").json()
check('live state unchanged by previews/captures', {k: live0[k] for k in ('revision', 'topics', 'current_topic_id')} == {k: live1[k] for k in ('revision', 'topics', 'current_topic_id')})
check('saved day snapshot unchanged', plan1['revision'] == plan0['revision'] and plan1['topics'][0]['notes'] == 'Seed personal note\n\nSource: https://example.com/seed')
seed = json.load(open(f'{O}/parent-baseline.json'))['seed']
check('seed topic untouched', api.get(f"/inbox/{seed['id']}").json() == seed)
json.dump(out, open(f'{O}/api-results.json', 'w'), indent=1, default=str)
print('DONE', sum(1 for c in out['checks'] if c['ok']), '/', len(out['checks']))
