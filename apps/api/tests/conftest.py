import pytest
from sqlmodel import create_engine

from rundown import db
from rundown.config import settings


@pytest.fixture(autouse=True)
def isolated_database(tmp_path, monkeypatch):
    path = tmp_path / 'test.db'
    engine = create_engine(f'sqlite:///{path}', connect_args={'check_same_thread': False})
    monkeypatch.setattr(settings, 'db_path', path)
    monkeypatch.setattr(settings, 'raw_cache_dir', tmp_path / 'raw')
    monkeypatch.setattr(settings, 'logs_dir', tmp_path / 'logs')
    monkeypatch.setattr(db, '_engine', engine)
    yield
    engine.dispose()
