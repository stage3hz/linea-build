#!/usr/bin/env python3
"""Create the small server/deployment ZIP for phone-based VPS setup."""
import hashlib
import json
import stat
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DESTINATION = ROOT.parent / 'linea-server-v0.5.1.zip'
FIXED = (
    'server/package.json', 'server/package-lock.json', 'server/Dockerfile',
    'server/.dockerignore', 'server/.env.example', 'server/README.server.md',
    'deploy/compose.production.yml', 'deploy/Caddyfile', 'deploy/.env.example',
    'deploy/backup.sh', 'docs/DEPLOY_FROM_IPHONE.md', 'docs/DEPLOYMENT.md',
    'docs/E2EE_ONLY_0.5.md', 'docs/API.md', 'docs/PLATINA_OWNER_0.5.1.md',
)


def main():
    source_files = sorted(p.relative_to(ROOT).as_posix() for p in (ROOT / 'server/src').rglob('*') if p.is_file())
    names = sorted(set(FIXED) | set(source_files))
    frozen = json.loads((ROOT / 'docs/SOURCE_MANIFEST_0.5.1.json').read_text())['files']
    data = {}
    for name in names:
        path = ROOT / name
        if path.is_symlink() or not path.is_file():
            raise ValueError(f'Not a regular owned file: {name}')
        raw = path.read_bytes()
        if name in frozen and hashlib.sha256(raw).hexdigest() != frozen[name]:
            raise ValueError(f'Production source changed after validation: {name}')
        if b'PRIVATE KEY-----' in raw:
            raise ValueError(f'Unexpected private-key material: {name}')
        data[name] = raw
    data['README.md'] = (
        '# Линия: сервер 0.5.1\n\n'
        'Порядок запуска с iPhone: [docs/DEPLOY_FROM_IPHONE.md](docs/DEPLOY_FROM_IPHONE.md).\n\n'
        'Распакуйте архив в новый каталог /opt/linea на своём VPS. Внутри сразу находятся server/, deploy/ и docs/. '
        'Это исходники сервера и конфигурация Docker; iOS-приложение и секреты подписи сюда не включены.\n\n'
        'Бессрочная Platina: [docs/PLATINA_OWNER_0.5.1.md](docs/PLATINA_OWNER_0.5.1.md). '
        'До обновления существующего сервера нужна резервная копия: схема 4 мигрирует в 5.\n\n'
        'Тесты, их журналы и исходники мобильного клиента, на которые ссылаются документы, '
        'находятся в полном исходном комплекте linea-messenger-v0.5.1.zip. '
        'Он также включает tools/ios-cloud-setup с инструкцией облачной сборки с одного iPhone. '
        'В этом компактном архиве этих каталогов нет.\n'
    ).encode('utf-8')
    temporary = DESTINATION.with_suffix('.zip.tmp')
    try:
        with zipfile.ZipFile(temporary, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for name, raw in sorted(data.items()):
                item = zipfile.ZipInfo(name)
                item.create_system = 3
                item.compress_type = zipfile.ZIP_DEFLATED
                item.external_attr = (stat.S_IFREG | (0o755 if name.endswith('.sh') else 0o644)) << 16
                archive.writestr(item, raw, compresslevel=9)
        with zipfile.ZipFile(temporary) as archive:
            if archive.testzip() is not None or set(archive.namelist()) != set(data):
                raise ValueError('Server ZIP validation failed')
            for name, raw in data.items():
                if archive.read(name) != raw:
                    raise ValueError(f'Archived bytes differ: {name}')
        temporary.replace(DESTINATION)
    finally:
        temporary.unlink(missing_ok=True)
    print(json.dumps({'path': str(DESTINATION), 'fileCount': len(data), 'sizeBytes': DESTINATION.stat().st_size,
                      'sha256': hashlib.sha256(DESTINATION.read_bytes()).hexdigest(), 'crc': 'PASS'}, indent=2))


if __name__ == '__main__':
    main()
