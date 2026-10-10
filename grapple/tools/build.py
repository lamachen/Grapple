#!/usr/bin/env python3
"""Baut aus src/*.js + tools/template.html eine einzige, abhaengigkeitsfreie index.html."""
import glob, os, sys, io

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC  = os.path.join(ROOT, 'src')
TPL  = os.path.join(ROOT, 'tools', 'template.html')
OUT  = os.path.join(ROOT, 'index.html')

files = sorted(glob.glob(os.path.join(SRC, '*.js')))
parts = []
for f in files:
    name = os.path.basename(f)
    with io.open(f, encoding='utf-8') as fh:
        body = fh.read()
    parts.append("\n/* ===== %s ===== */\n" % name)
    parts.append(body)
js = "\n".join(parts)

with io.open(TPL, encoding='utf-8') as fh:
    html = fh.read()
assert '/*__GAME_JS__*/' in html, 'Platzhalter fehlt'
html = html.replace('/*__GAME_JS__*/', js)
with io.open(OUT, 'w', encoding='utf-8') as fh:
    fh.write(html)
print('gebaut: %s  (%d Dateien, %.1f KB)' % (OUT, len(files), len(html)/1024.0))
