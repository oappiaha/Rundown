import pytest
from sqlmodel import create_engine

from rundown import db
from rundown.config import settings

# The module-level engine is built from settings.db_path at import time, i.e. the
# real local database. Replace it before any test runs so that nothing that
# restores "the original" (monkeypatch.undo(), a fixture teardown order bug) can
# ever point a test at real data: the fallback is a throwaway in-memory engine.
db._engine = create_engine('sqlite://', connect_args={'check_same_thread': False})


@pytest.fixture(autouse=True)
def isolated_database(tmp_path, monkeypatch):
    path = tmp_path / 'test.db'
    engine = create_engine(f'sqlite:///{path}', connect_args={'check_same_thread': False})
    monkeypatch.setattr(settings, 'db_path', path)
    monkeypatch.setattr(settings, 'raw_cache_dir', tmp_path / 'raw')
    monkeypatch.setattr(settings, 'logs_dir', tmp_path / 'logs')
    monkeypatch.setattr(settings, 'assets_dir', tmp_path / 'assets')
    monkeypatch.setattr(db, '_engine', engine)
    yield
    engine.dispose()
