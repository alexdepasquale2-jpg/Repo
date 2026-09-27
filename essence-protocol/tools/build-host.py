#!/usr/bin/env python3
"""Build the hosted (claude.ai page) copies of the game and the content editor.

    python tools/build-host.py [OUT]      OUT defaults to essence-protocol/host/ (ignored by git)

    OUT/game/index.html      the game with its CSS and JS inlined; OUT/game/db/ beside it
    OUT/editor/index.html    the content editor with its CSS, JS and the content snapshot inlined;
                             OUT/editor/editor/bake-worker.js and OUT/editor/js/ hold what its
                             bake worker loads, OUT/editor/icon*.* the app icons it shows

A claude.ai page is written without <!doctype>, <html>, <head> and <body> (the host adds them),
with its <title> first. Publish OUT/game/index.html with db/*.json as files, and
OUT/editor/index.html with editor/bake-worker.js, js/*.js and the icons as files (the editor
page declares the db capability, where it keeps the draft for Claude Code, and downloads).
"""
import os
import re
import shutil
import sys

SRC = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.join(SRC, 'host')


def read(*p):
    with open(os.path.join(SRC, *p), encoding='utf-8') as f:
        return f.read()


def strip_document(s):
    s = re.sub(r'<!doctype html>\s*<html[^>]*>\s*<head>', '', s, flags=re.I)
    for t in ('</head>', '<body>', '</body>', '</html>'):
        s = s.replace(t, '')
    return re.sub(r'<meta[^>]*>\n', '', s)


def inline_scripts(s, base):
    def inline(m):
        code = read(*os.path.normpath(os.path.join(base, m.group(1))).split(os.sep))
        assert '</script' not in code, m.group(1) + ' contains </script'
        return '<script>\n' + code + '\n</script>'
    return re.sub(r'<script src="([^"]+\.js)"></script>', inline, s)


def build_game():
    out = os.path.join(OUT, 'game')
    shutil.rmtree(out, ignore_errors=True)
    os.makedirs(os.path.join(out, 'db'))
    for f in os.listdir(os.path.join(SRC, 'db')):
        shutil.copy(os.path.join(SRC, 'db', f), os.path.join(out, 'db', f))
    s = strip_document(read('index.html'))
    s = re.sub(r'<link rel="(manifest|icon|apple-touch-icon|preload)"[^>]*>\n', '', s)
    s = s.replace('<link rel="stylesheet" href="style.css">', '<style>\n' + read('style.css') + '\n</style>')
    s = s.replace('<link rel="stylesheet" href="build.css">', '<style>\n' + read('build.css') + '\n</style>')
    s = inline_scripts(s, '')
    assert 'href="build.css"' not in s and 'src="js/' not in s
    assert s.lstrip().startswith('<title>')
    with open(os.path.join(out, 'index.html'), 'w', encoding='utf-8') as f:
        f.write(s)
    return os.path.join(out, 'index.html'), len(s)


def build_editor():
    out = os.path.join(OUT, 'editor')
    shutil.rmtree(out, ignore_errors=True)
    for d in ('editor', 'js', 'icons'):
        os.makedirs(os.path.join(out, d))
    s = strip_document(read('editor', 'index.html'))
    s = re.sub(r'<link rel="icon"[^>]*>\n', '', s)
    s = s.replace('<link rel="stylesheet" href="editor.css">', '<style>\n' + read('editor', 'editor.css') + '\n</style>')
    s = s.replace("<script>window.EDITOR_ROOT = '../';</script>", "<script>window.EDITOR_ROOT = ''; window.EDITOR_HERE = 'editor/';</script>")
    s = inline_scripts(s, 'editor')
    assert s.lstrip().startswith('<title>') and "EDITOR_HERE = 'editor/'" in s
    with open(os.path.join(out, 'index.html'), 'w', encoding='utf-8') as f:
        f.write(s)
    shutil.copy(os.path.join(SRC, 'editor', 'bake-worker.js'), os.path.join(out, 'editor', 'bake-worker.js'))
    for f in ('schema.js', 'essences.js', 'designs.js', 'baker.js'):
        shutil.copy(os.path.join(SRC, 'js', f), os.path.join(out, 'js', f))
    shutil.copy(os.path.join(SRC, 'icon.svg'), os.path.join(out, 'icon.svg'))
    for f in ('icon-192.png', 'maskable-512.png'):
        shutil.copy(os.path.join(SRC, 'icons', f), os.path.join(out, 'icons', f))
    return os.path.join(out, 'index.html'), len(s)


if __name__ == '__main__':
    for name, (path, size) in (('game', build_game()), ('editor', build_editor())):
        print(f'{name}: {path} ({size // 1024} KB)')
