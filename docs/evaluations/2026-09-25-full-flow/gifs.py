import json
from pathlib import Path
from PIL import Image,ImageDraw,ImageFont
O=Path('/private/tmp/rundown-full-audit')
font='/System/Library/Fonts/Supplemental/Arial.ttf'
f=ImageFont.truetype(font,23);small=ImageFont.truetype(font,17);big=ImageFont.truetype(font,36)
rows=[json.loads(x) for x in (O/'frames.jsonl').read_text().splitlines()]
rows=[x for x in rows if not x['label'].startswith('Audit interrupted')]
for x in rows:
 if x['frame']==4:x['label']='05 • Immediate recollection is rate-limited; no second request'
W,H=1280,998

def card(title,lines):
 im=Image.new('RGB',(W,H),'#111b2c');d=ImageDraw.Draw(im);d.text((60,65),'RUNDOWN / ACTUAL UI AUDIT',font=small,fill='#88bbff');d.text((60,140),title,font=big,fill='white')
 for i,line in enumerate(lines):d.text((60,235+i*55),line,font=f,fill='#d8e5f8')
 return im.quantize(colors=128)

def shot(row):
 im=Image.new('RGB',(W,H),'#182234');d=ImageDraw.Draw(im);d.text((20,12),'RUNDOWN · Step-by-step browser capture',font=small,fill='#b9d7ff');d.text((990,12),'SYNTHETIC DATA',font=small,fill='#ffc574');label=row['label'].split(' • ',1)[-1];d.text((20,43),label,font=f,fill='white')
 src=Image.open(O/'frames'/f"{row['frame']:03d}.png").convert('RGB');src.thumbnail((W,900));im.paste(src,((W-src.width)//2,88));return im.quantize(colors=128)
intro=card('Does the core workflow hold together?',[
 'Sources → Inbox → Research → Saved Shows → Live → Overlay',
 'Actual Chromium clicks against the real local API and disposable SQLite.',
 'Fake YouTube/Reddit/RSS, AI and public-link responses. No paid calls.',
 'Playback, phone, reuse, review and failure/recovery paths included.',
 'This GIF compresses captured UI steps; it is not a real-time video.',
 'OBS WebSocket is a protocol simulator; actual OBS is not deployed.',
 'Optional branches are shown to expose complexity, not prescribe it.'
])
end=card('Audit verdict: core works; simplify the route',[
 'PASS: collect, review, shortlist, save, activate, run, insert on air.',
 'PASS: overlay polling and private notes stay out of rendered overlay.',
 'PASS: edit guards, recovery, reuse and phone interactions.',
 'FOUND + FIXED: password authentication bug in OBS refresh bridge.',
 'OBS refresh now passes against the authenticated simulator.',
 'GAP: no OBS setup/status flow; “Connected” means API, not OBS.',
 'SIMPLIFY: one capture/review stage, one show editor, one live screen.',
 'No real OBS output, real Reddit access or exhaustive input permutations tested.'
])
sets=[('rundown-full-ui-flow',rows),('rundown-01-core-flow',[x for x in rows if x['frame']<=35]),('rundown-02-alternatives-and-recovery',[x for x in rows if 37<=x['frame']<=65 or x['frame']>=71]),('rundown-03-phone',[x for x in rows if 66<=x['frame']<=70])]
for name,rs in sets:
 ims=[intro]+[shot(x) for x in rs]+[end];dur=[4500]+[1700]*len(rs)+[6500]
 ims[0].save(O/(name+'.gif'),save_all=True,append_images=ims[1:],duration=dur,loop=0,optimize=True,disposal=2)
 print(name,len(rs),'steps',round((O/(name+'.gif')).stat().st_size/1024/1024,2),'MB',flush=True)
(O/'caption-index.json').write_text(json.dumps(rows,indent=2))
