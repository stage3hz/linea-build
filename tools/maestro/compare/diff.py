#!/usr/bin/env python3
"""Difference scores of the side-by-side comparison (.github/workflows/native-compare.yml).

    python3 tools/maestro/compare/diff.py <folder> <plan.txt>

For every pair of the plan (tools/maestro/compare/plan.txt, setup rows left out) whose two pictures are in the folder
(ref-NAME.png: the previous React Native app, nat-NAME.png: the native app, same simulator, same data) it measures
how far the native picture is from the reference:

  * mean absolute difference (MAD): the average over all pixels and the three colour channels of |ref - nat|, in per
    cent of full scale (0 = identical; a whole screen of a different colour is tens of per cent);
  * changed pixels: the share of pixels where some channel differs by more than 24 of 255 (antialiasing and
    gradients stay under it; a moved row, another colour or a missing element do not);
  * the worst of six horizontal bands (top to bottom), so the place to look is named.

The status bar (the top STATUS_BAR share of the height: the clock, the island, the battery) is left out of all of it.
It writes diff-NAME.jpg (the reference dimmed to grey with the differences in red, the status bar band crossed out)
and REPORT.md: the table of all pairs sorted by the worst difference first, then the pairs that could not be scored.
Needs Pillow only.
"""
import os
import sys

from PIL import Image, ImageChops, ImageDraw, ImageStat

STATUS_BAR = 0.07   # of the height: 62 pt of an iPhone Pro's 874 pt is 0.071; the clock, island and battery are all inside
THRESHOLD = 24      # per channel, of 255: a pixel counts as changed above it
BANDS = 6
HEIGHT = 1600       # of the heat map


def plan_names(path):
    names = []
    for line in open(path, encoding='utf-8'):
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        cells = [cell.strip() for cell in line.split('|')]
        if len(cells) >= 3 and cells[2] != 'setup':
            names.append(cells[0])
    return names


def strongest(diff):
    red, green, blue = diff.split()
    return ImageChops.lighter(ImageChops.lighter(red, green), blue)


def score(ref_path, nat_path, heat_path):
    ref = Image.open(ref_path).convert('RGB')
    nat = Image.open(nat_path).convert('RGB')
    note = ''
    if nat.size != ref.size:
        note = f'sizes differ ({ref.width}x{ref.height} vs {nat.width}x{nat.height}); native scaled'
        nat = nat.resize(ref.size, Image.LANCZOS)
    width, height = ref.size
    top = round(height * STATUS_BAR)
    diff = ImageChops.difference(ref, nat)
    body = diff.crop((0, top, width, height))
    mad = sum(ImageStat.Stat(body).mean) / 3 / 255 * 100
    histogram = strongest(body).histogram()
    changed = sum(histogram[THRESHOLD + 1:]) / max(1, width * (height - top)) * 100
    band_height = (height - top) / BANDS
    bands = []
    for index in range(BANDS):
        part = diff.crop((0, round(top + index * band_height), width, round(top + (index + 1) * band_height)))
        bands.append(sum(ImageStat.Stat(part).mean) / 3 / 255 * 100)
    worst = max(range(BANDS), key=lambda index: bands[index])
    # The heat map: the reference in dim grey, the differences in red (amplified four times), the status bar crossed out.
    grey = ref.convert('L').point(lambda value: int(value * 0.3))
    heat = strongest(diff).point(lambda value: min(255, value * 4))
    picture = Image.merge('RGB', (ImageChops.lighter(grey, heat), ImageChops.subtract(grey, heat), ImageChops.subtract(grey, heat)))
    draw = ImageDraw.Draw(picture)
    draw.rectangle((0, 0, width, top), fill=(24, 24, 40))
    for x in range(-top, width, max(12, top // 3)):
        draw.line((x, top, x + top, 0), fill=(60, 60, 90), width=3)
    for index in range(1, BANDS):
        y = round(top + index * band_height)
        draw.line((0, y, 18, y), fill=(120, 120, 140), width=3)
    picture = picture.resize((round(width * HEIGHT / height), HEIGHT), Image.LANCZOS)
    picture.save(heat_path, 'JPEG', quality=80, optimize=True)
    return mad, changed, worst, bands, note


BAND_WORDS = ['top', 'upper', 'upper middle', 'lower middle', 'lower', 'bottom']


def main():
    folder, plan = sys.argv[1], sys.argv[2]
    names = plan_names(plan)
    reasons = {}
    missing_file = os.path.join(folder, 'missing.txt')
    if os.path.exists(missing_file):
        for line in open(missing_file, encoding='utf-8'):
            if ':' in line:
                key, why = line.split(':', 1)
                reasons.setdefault(key.strip(), []).append(why.strip())
    scored, unscored = [], []
    for name in names:
        ref_path, nat_path = os.path.join(folder, f'ref-{name}.png'), os.path.join(folder, f'nat-{name}.png')
        if not (os.path.exists(ref_path) and os.path.exists(nat_path)):
            why = '; '.join(reasons.get(f'ref-{name}', []) + reasons.get(f'nat-{name}', [])) or 'a picture is missing'
            side = ' and '.join(side for side, path in (('reference', ref_path), ('native', nat_path)) if not os.path.exists(path))
            unscored.append((name, f'no {side} picture', why))
            continue
        try:
            mad, changed, worst, bands, note = score(ref_path, nat_path, os.path.join(folder, f'diff-{name}.jpg'))
        except Exception as error:  # a broken picture must not stop the report
            unscored.append((name, 'not scored', str(error)))
            continue
        flow_notes = '; '.join(reasons.get(f'ref-{name}', []) + reasons.get(f'nat-{name}', []))
        scored.append((mad, changed, name, worst, bands, '; '.join(item for item in (note, flow_notes) if item)))
    scored.sort(key=lambda row: (-row[0], -row[1]))
    rows = ['# Native vs reference: the worst screens first', '',
            f'Mean absolute difference (MAD, % of full scale, all channels) and the share of pixels differing by more than '
            f'{THRESHOLD}/255, the status bar (top {round(STATUS_BAR * 100)} % of the height) left out. The heat map '
            '(`diff-NAME.jpg`) is the reference in grey with the differences in red; the band is where the most difference is.',
            '', f'Scored: {len(scored)} of {len(names)} pairs.', '',
            '| rank | pair | MAD % | changed px % | worst band | pictures | note |', '|---|---|---|---|---|---|---|']
    for rank, (mad, changed, name, worst, bands, note) in enumerate(scored, 1):
        rows.append(f'| {rank} | {name} | {mad:.2f} | {changed:.1f} | {BAND_WORDS[worst]} ({bands[worst]:.1f}) | '
                    f'[pair](pair-{name}.jpg) · [diff](diff-{name}.jpg) | {note} |')
    if unscored:
        rows += ['', '## Not scored', '', '| pair | what | why |', '|---|---|---|']
        rows += [f'| {name} | {what} | {why} |' for name, what, why in unscored]
    others = {key: value for key, value in reasons.items() if not any(key in (f'ref-{name}', f'nat-{name}') for name in names)}
    if others:
        rows += ['', '## Other notes of the run', '']
        rows += [f'- {key}: {"; ".join(value)}' for key, value in sorted(others.items())]
    with open(os.path.join(folder, 'REPORT.md'), 'w', encoding='utf-8') as out:
        out.write('\n'.join(rows) + '\n')
    print(f'scored {len(scored)}, not scored {len(unscored)}')


if __name__ == '__main__':
    main()
