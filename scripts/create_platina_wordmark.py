from pathlib import Path
import random
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'mobile/assets/branding'
W, H = 1600, 520

# Original outline lettering drawn for PLATINA from the supplied visual style.
# No fonts, external resources, raster images or SVG filters are used.
GLYPHS = {
 'P': 'M4 78 L168 78 Q200 78 221 51 L208 112 L208 220 L144 278 L114 278 L114 386 Q114 407 130 425 L87 484 L48 431 Q64 410 64 387 L64 147 Q62 109 4 78 Z M114 128 L164 128 L164 202 L114 244 Z',
 'L': 'M18 78 L130 74 L105 111 L105 328 Q105 352 128 365 L166 365 Q187 365 216 327 L198 394 L145 443 L35 397 L52 374 L52 137 Q49 106 18 78 Z',
 'A': 'M6 151 L96 61 Q108 49 116 20 Q109 62 127 80 L214 151 L200 183 L200 378 Q200 399 213 420 L175 479 L145 397 L145 315 Q144 302 134 307 L100 326 Q90 332 90 344 L90 380 Q90 401 99 409 L56 477 L33 422 Q50 401 50 378 L50 185 Z M93 171 L125 136 L156 171 L156 245 L94 280 Z',
 'T': 'M2 78 Q104 87 232 63 L194 108 L179 189 L153 147 L148 129 L130 129 L130 387 Q130 408 145 431 L103 490 L67 434 Q82 413 82 388 L82 133 L62 133 L32 178 L22 118 Z',
 'I': 'M7 82 L131 78 L108 113 L108 380 Q108 407 125 431 L83 486 L38 431 Q63 415 63 382 L63 138 Q60 105 7 82 Z',
 'N': 'M8 80 L80 80 L164 244 L164 129 Q163 108 142 82 L222 82 L203 113 L203 384 Q202 408 218 428 L174 473 L153 408 L67 228 L67 386 Q70 408 89 431 L48 473 L14 432 Q29 413 29 387 L29 143 Q28 110 8 80 Z',
}
PLACEMENT = [('P',20),('L',250),('A',474),('T',710),('I',960),('N',1112),('A',1350)]

EDGES = {
 'P': ['M20 85 L169 85 Q196 85 211 67', 'M70 151 L70 386 Q70 412 57 430 L86 470', 'M121 136 L157 136 L157 198 L122 228', 'M200 116 L200 216 L147 264'],
 'L': ['M36 85 L116 82', 'M59 141 L59 375 L44 394 L145 432 L192 390', 'M112 326 Q112 349 131 357 L168 357 Q188 357 203 344'],
 'A': ['M20 149 L101 68 L110 46', 'M58 188 L58 379 Q58 405 42 421 L56 461', 'M98 172 L125 144 L149 172 L149 241 L101 269', 'M207 153 L192 184 L192 381 Q192 404 204 420 L176 462', 'M97 339 Q98 335 104 331 L136 312'],
 'T': ['M21 86 Q109 93 213 74', 'M90 140 L90 388 Q89 414 76 433 L103 475', 'M138 136 L148 158 L174 179 L187 110'],
 'I': ['M27 89 L118 86', 'M71 143 L71 382 Q71 412 49 430 L83 473', 'M116 419 L99 381 L99 118'],
 'N': ['M24 87 L75 87 L173 278', 'M37 146 L37 386 Q37 416 23 431 L48 460', 'M173 130 L173 245', 'M157 89 L209 89', 'M195 118 L195 383 Q195 413 208 428 L175 461'],
}

def gradient(identifier, stops, vertical=True):
    axes = 'x1="0" y1="18" x2="36" y2="500"' if vertical else 'x1="8" y1="110" x2="206" y2="445"'
    return f'<linearGradient id="{identifier}" gradientUnits="userSpaceOnUse" {axes}>' + ''.join(f'<stop offset="{offset}" stop-color="{colour}"/>' for offset,colour in stops) + '</linearGradient>'

def render(light=False):
    mode = 'light' if light else 'dark'
    face = [('0','#F9FBFD'),('.10','#535E6C'),('.19','#D2D9E2'),('.29','#FFFFFF'),('.37','#919EAE'),('.46','#353E4A'),('.50','#B9C4D0'),('.54','#FBFDFF'),('.58','#CAD3DC'),('.585','#1A2029'),('.64','#3B4654'),('.73','#A0ACB9'),('.80','#F1F4F8'),('.845','#FFFFFF'),('.89','#737F8D'),('1','#242D3A')]
    rim = [('0','#F8FAFC'),('.16','#FFFFFF'),('.26','#6A7787'),('.36','#F4F7FB'),('.48','#18212D'),('.55','#FFFFFF'),('.71','#A4AFBE'),('.80','#111925'),('.91','#EDF2F9'),('1','#6E7B8D')]
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" role="img" aria-labelledby="title desc">',
        '<title id="title">PLATINA</title>',
        '<desc id="desc">Original angular gothic PLATINA lettering with silver chrome bevels. Transparent background. Pure vector artwork.</desc>',
        '<defs>', gradient('face',face), gradient('rim',rim,False),
        '<linearGradient id="side" x1="0" y1="0" x2="1" y2="0"><stop stop-color="#0C1420" stop-opacity=".72"/><stop offset=".27" stop-color="#050911" stop-opacity=".02"/><stop offset=".60" stop-color="#FFFFFF" stop-opacity=".13"/><stop offset=".78" stop-color="#07111E" stop-opacity=".20"/><stop offset="1" stop-color="#060B14" stop-opacity=".65"/></linearGradient>',
        '<linearGradient id="sweep" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#FFFFFF" stop-opacity=".62"/><stop offset=".46" stop-color="#FFFFFF" stop-opacity="0"/><stop offset="1" stop-color="#000000" stop-opacity=".30"/></linearGradient>']
    for name,d in GLYPHS.items():parts.append(f'<clipPath id="clip-{name}"><path d="{d}" fill-rule="evenodd" clip-rule="evenodd"/></clipPath>')
    parts.append('</defs>')
    for index,(name,x) in enumerate(PLACEMENT):
        d=GLYPHS[name];rng=random.Random(891+index)
        parts.append(f'<g id="letter-{index+1}-{name}" transform="translate({x} 0)">')
        # The shallow shifted solid is the visible cut edge, not a long extrusion.
        parts.append(f'<path d="{d}" transform="translate(4 7)" fill="#111823" fill-rule="evenodd" stroke="{ "#111722" if light else "#737E8D" }" stroke-width="2.2" stroke-linejoin="miter"/>')
        parts.append(f'<path d="{d}" fill="url(#face)" fill-rule="evenodd" stroke="{ "#18202B" if light else "#F4F7FA" }" stroke-width="10" stroke-linejoin="miter"/>')
        parts.append(f'<path d="{d}" fill="url(#face)" fill-rule="evenodd" stroke="url(#rim)" stroke-width="7" stroke-linejoin="miter"/>')
        parts.append(f'<path d="{d}" fill="none" stroke="#101722" stroke-width="2.8" stroke-linejoin="miter"/>')
        parts.append(f'<g clip-path="url(#clip-{name})">')
        parts.append('<path d="M0 0 H240 V510 H0 Z" fill="url(#side)"/>')
        parts.append(f'<path d="M0 {118+index*3} Q106 {76+index*5} 232 {135-index*4} L232 178 Q100 118 0 171 Z" fill="url(#sweep)"/>')
        parts.append(f'<path d="M0 {293+index*2} Q99 {265-index*3} 235 {286+index*3} L235 320 Q103 282 0 318 Z" fill="#050B14" opacity=".18"/>')
        # Fine etched lines remain vectors and intentionally vanish at badge size.
        for n in range(29):
            sx=rng.uniform(27,196);sy=rng.uniform(89,447);ln=rng.uniform(4,25);dy=rng.uniform(-9,4)
            colour='#FFFFFF' if n%3 else '#030912';opacity='.24' if n%3 else '.19'
            parts.append(f'<path d="M{sx:.2f} {sy:.2f} l{ln*.44:.2f} {dy*.50:.2f} l{ln*.56:.2f} {dy*.50:.2f}" fill="none" stroke="{colour}" stroke-opacity="{opacity}" stroke-width=".8"/>')
        for n in range(18):
            sx=rng.uniform(33,192);sy=rng.uniform(98,435)
            parts.append(f'<circle cx="{sx:.2f}" cy="{sy:.2f}" r="{rng.uniform(.35,.75):.2f}" fill="#FFFFFF" opacity=".26"/>')
        parts.append('</g>')
        for edge in EDGES[name]:
            parts.append(f'<path d="{edge}" fill="none" stroke="#F9FCFF" stroke-opacity=".89" stroke-width="1.55" stroke-linejoin="miter"/>')
        parts.append('</g>')
    for x,y,size in [(86,266,14),(838,132,9),(1505,172,11)]:
        parts.append(f'<path d="M{x} {y-size} L{x+1.7} {y-1.7} L{x+size} {y} L{x+1.7} {y+1.7} L{x} {y+size} L{x-1.7} {y+1.7} L{x-size} {y} L{x-1.7} {y-1.7} Z" fill="#FFFFFF" opacity=".92"/>')
    parts.append('</svg>')
    svg='\n'.join(parts)+'\n';ET.fromstring(svg)
    filename='platina-chrome-light.svg' if light else 'platina-chrome.svg'
    (OUT/filename).write_text(svg)
    return filename

if __name__ == '__main__':
    OUT.mkdir(parents=True,exist_ok=True)
    for light in (False,True):print(render(light))
