#!/usr/bin/env python3
"""Side-by-side pictures for .github/workflows/native-compare.yml.

    python3 tools/compare-pairs.py <folder> <names file>

The folder holds ref-NN-name.png (the previous React Native app) and nat-NN-name.png (the native app), photographed
on the same simulator with the same data. For every line `NN-name` of the names file it writes pair-NN-name.jpg:
the reference on the left, the native app on the right, both at the same height, each with a caption; a missing
side is a grey panel that says so. It also writes INDEX.md: the table of what was photographed and what was not
(with the reason the workflow recorded in missing.txt, when there is one).
"""
import os
import sys

from PIL import Image, ImageDraw, ImageFont

HEIGHT = 1600  # each side; the simulator's 3x pictures are about 1206 x 2622
GAP = 24
CAPTION = 64
FONTS = ['/System/Library/Fonts/Supplemental/Arial.ttf', '/Library/Fonts/Arial Unicode.ttf',
         '/System/Library/Fonts/Supplemental/Arial Unicode.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf']


def font(size):
    for path in FONTS:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size), True
            except OSError:
                pass
    return ImageFont.load_default(), False


def side(path, width_hint):
    if path and os.path.exists(path):
        picture = Image.open(path).convert('RGB')
        return picture.resize((round(picture.width * HEIGHT / picture.height), HEIGHT), Image.LANCZOS), True
    return Image.new('RGB', (width_hint, HEIGHT), (60, 60, 64)), False


def main():
    folder, names_file = sys.argv[1], sys.argv[2]
    names = [line.strip() for line in open(names_file, encoding='utf-8') if line.strip() and not line.startswith('#')]
    reasons = {}
    missing_file = os.path.join(folder, 'missing.txt')
    if os.path.exists(missing_file):
        for line in open(missing_file, encoding='utf-8'):
            if ':' in line:
                key, why = line.split(':', 1)
                reasons.setdefault(key.strip(), why.strip())
    caption_font, cyrillic = font(36)
    titles = ('прежнее (React Native)', 'новое (нативное)') if cyrillic else ('reference (React Native)', 'native')
    rows = ['# Previous app vs native app, same simulator, same data', '',
            '| # | screen | reference | native | note |', '|---|---|---|---|---|']
    for name in names:
        ref_path = os.path.join(folder, f'ref-{name}.png')
        nat_path = os.path.join(folder, f'nat-{name}.png')
        left, has_left = side(ref_path, 736)
        right, has_right = side(nat_path, left.width)
        if not has_left:
            left = Image.new('RGB', (right.width, HEIGHT), (60, 60, 64))
        canvas = Image.new('RGB', (left.width + GAP + right.width, HEIGHT + CAPTION), (18, 18, 20))
        canvas.paste(left, (0, CAPTION))
        canvas.paste(right, (left.width + GAP, CAPTION))
        draw = ImageDraw.Draw(canvas)
        number, _, title_words = name.partition('-')
        for x, width, title, present in ((0, left.width, titles[0], has_left), (left.width + GAP, right.width, titles[1], has_right)):
            draw.text((x + 16, 12), f'{number} · {title}', fill=(235, 235, 240), font=caption_font)
            if not present:
                draw.text((x + 40, CAPTION + HEIGHT // 2 - 30), 'нет снимка' if cyrillic else 'no picture', fill=(200, 200, 205), font=caption_font)
        canvas.save(os.path.join(folder, f'pair-{name}.jpg'), 'JPEG', quality=82, optimize=True)
        note = '; '.join(why for key, why in reasons.items() if key in (f'ref-{name}', f'nat-{name}'))
        rows.append(f'| {number} | {title_words} | {"yes" if has_left else "**no**"} | {"yes" if has_right else "**no**"} | {note} |')
    rows += ['', 'Each pair: `pair-NN-name.jpg` (reference left, native right); the full pictures: `ref-NN-name.png`, `nat-NN-name.png`.']
    with open(os.path.join(folder, 'INDEX.md'), 'w', encoding='utf-8') as out:
        out.write('\n'.join(rows) + '\n')


if __name__ == '__main__':
    main()
