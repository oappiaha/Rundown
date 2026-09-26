from PIL import Image,ImageDraw,ImageFont
from pathlib import Path
import json
O=Path('/private/tmp/rundown-ui-acceptance'); records=[json.loads(x) for x in (O/'frames.jsonl').read_text().splitlines() if json.loads(x)['frame']>=8]
font=ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial.ttf',19)
frames=[]
for r in records:
 im=Image.open(O/'frames'/f"{r['frame']:03}.png").convert('RGB'); im.thumbnail((1000,760),Image.Resampling.LANCZOS)
 canvas=Image.new('RGB',(1040,828),'#f5f1e8'); canvas.paste(im,((1040-im.width)//2,44))
 d=ImageDraw.Draw(canvas);d.text((20,12),r['label'],font=font,fill='#16140f');d.text((20,797),'Rundown concept · fake stories · captured browser states',font=font,fill='#666052')
 frames.append(canvas.quantize(colors=96))
frames[0].save(O/'rundown-discovery-walkthrough.gif',save_all=True,append_images=frames[1:],duration=2300,loop=0,optimize=True)
print((O/'rundown-discovery-walkthrough.gif').stat().st_size)
