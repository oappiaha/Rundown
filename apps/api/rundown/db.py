from collections.abc import Iterator

from sqlmodel import Session, SQLModel, create_engine

from rundown.config import settings

_engine = create_engine(
    f"sqlite:///{settings.db_path}",
    echo=False,
    connect_args={"check_same_thread": False},
)


def init_db() -> None:
    from rundown import models  # noqa: F401  -- register tables

    SQLModel.metadata.create_all(_engine)


def get_session() -> Iterator[Session]:
    with Session(_engine) as session:
        yield session


def session() -> Session:
    return Session(_engine)
