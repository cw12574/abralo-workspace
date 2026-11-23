"""Rasterize the existing rectangular SVG brand mark for Windows notifications.

Requires Pillow. The deliberately limited path parser rejects new SVG commands
instead of silently producing a different logo when the source asset changes.
"""
from pathlib import Path
import re
import xml.etree.ElementTree as ET
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parents[1]
public = root / 'apps/web/public'
svg = ET.parse(public / 'icon.svg').getroot()
ns = {'s': 'http://www.w3.org/2000/svg'}
assert svg.attrib['viewBox'] == '0 0 64 64'
scale = 16
im = Image.new('RGBA', (64 * scale, 64 * scale))
draw = ImageDraw.Draw(im)
rect = svg.find('s:rect', ns)
draw.rounded_rectangle((0, 0, im.width - 1, im.height - 1),
                       radius=float(rect.attrib['rx']) * scale, fill=rect.attrib['fill'])
group = svg.find('s:g', ns)
data = group.find('s:path', ns).attrib['d']
tokens = re.findall(r'[A-Za-z]|-?\d+(?:\.\d+)?', data)
x = y = 0
points = []
i = 0
while i < len(tokens):
    command = tokens[i]
    i += 1
    if command in ('M', 'm'):
        nx, ny = float(tokens[i]), float(tokens[i + 1])
        i += 2
        x, y = (nx, ny) if command == 'M' else (x + nx, y + ny)
        points = [(x, y)]
    elif command in ('h', 'v'):
        amount = float(tokens[i])
        i += 1
        if command == 'h':
            x += amount
        else:
            y += amount
        points.append((x, y))
    elif command == 'z':
        assert len(points) == 4
        xs, ys = zip(*points)
        draw.rectangle((min(xs)*scale, min(ys)*scale, max(xs)*scale-1, max(ys)*scale-1),
                       fill=group.attrib['fill'])
        x, y = points[0]
    else:
        raise ValueError(f'Unsupported SVG command: {command}')
im = im.resize((256, 256), Image.Resampling.LANCZOS)
im.save(public / 'notification.png')
im.save(public / 'notification.ico', sizes=[(16,16), (24,24), (32,32), (48,48), (64,64), (128,128), (256,256)])
print('Generated notification.png and notification.ico from icon.svg')
