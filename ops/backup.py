"""Daily local SQLite/attachment backup; keeps seven scheduled snapshots."""
from pathlib import Path
from datetime import datetime
import shutil
import sqlite3
import os

DATA = Path('/Users/rei/2026/Rundown/data')
DEST = Path('/Users/rei/services/rundown/backups')

def main():
    os.umask(0o077)
    DEST.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    temporary = DEST / ('.daily-' + stamp)
    final = DEST / ('daily-' + stamp)
    temporary.mkdir()
    try:
        with sqlite3.connect(f'file:{DATA}/rundown.db?mode=ro', uri=True) as source:
            with sqlite3.connect(temporary / 'rundown.db') as target:
                source.backup(target)
                if target.execute('pragma integrity_check').fetchone()[0] != 'ok':
                    raise RuntimeError('Backup integrity check failed')
        if (DATA / 'assets').exists():
            shutil.copytree(DATA / 'assets', temporary / 'assets')
        temporary.rename(final)
    except BaseException:
        shutil.rmtree(temporary)
        raise
    for old in sorted(DEST.glob('daily-*'), reverse=True)[7:]:
        if old.is_dir() and not old.is_symlink():
            shutil.rmtree(old)
    print('Backup completed:', final.name)

if __name__ == '__main__':
    main()
