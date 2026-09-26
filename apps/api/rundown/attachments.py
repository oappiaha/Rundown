"""Managed uploads: a file becomes a Discover topic with a durable attachment.

The request body is the raw file (no multipart parser is installed). The type
is decided from the bytes, never from the extension or the declared type; the
server never decodes pixels, it reads signatures and header dimensions only.
Files live under settings.assets_dir with a server-chosen name and are served
by opaque id with a fixed media type and nosniff.
"""

import hashlib
import os
import re
import struct
import time
from pathlib import Path
from urllib.parse import quote
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import FileResponse
from pydantic import ValidationError
from sqlmodel import Session

from rundown.config import settings
from rundown.inbox import MAX_LABEL, MAX_SOURCE_TEXT, MAX_TITLE, create_capture, full_detail
from rundown.library import saved_transaction
from rundown.models import Attachment
from rundown.show import TopicIn

router = APIRouter(prefix="/attachments", tags=["attachments"])

MAX_BYTES = 1024 * 1024
MAX_DIMENSION = 10000
MAX_PIXELS = 25_000_000
MAX_FILENAME = 120
IMAGE_TYPES = {"image/png": ".png", "image/jpeg": ".jpg"}
DOCUMENT_TYPES = {"application/pdf": ".pdf", "text/plain": ".txt", "text/markdown": ".md"}
EXTENSIONS = {**IMAGE_TYPES, **DOCUMENT_TYPES}
TEXT_SUFFIXES = {".txt": "text/plain", ".md": "text/markdown", ".markdown": "text/markdown"}
ID_PATTERN = re.compile(r"^[0-9a-f]{32}$")


class Rejected(Exception):
    """A safe user-facing reason; nothing was stored."""


def display_filename(value: str) -> str:
    """The client's name is shown back, never used as a path: control characters,
    separators and `..` segments are removed and the length is bounded."""
    cleaned = "".join(c for c in value if ord(c) >= 32 and ord(c) != 127)
    cleaned = cleaned.replace("\\", "/")
    parts = [p.strip() for p in cleaned.split("/") if p.strip() not in {"", ".", ".."}]
    name = parts[-1] if parts else ""
    name = " ".join(name.split())
    if not name or name in {".", ".."}:
        name = "upload"
    return name[:MAX_FILENAME]


def png_dimensions(data: bytes) -> tuple[int, int]:
    if len(data) < 33 or data[12:16] != b"IHDR":
        raise Rejected("This PNG file is malformed.")
    width, height = struct.unpack(">II", data[16:24])
    return width, height


def jpeg_dimensions(data: bytes) -> tuple[int, int]:
    """Walk the marker segments to the first frame header; bounded by the file size."""
    index = 2
    length = len(data)
    while index + 4 <= length:
        if data[index] != 0xFF:
            raise Rejected("This JPEG file is malformed.")
        marker = data[index + 1]
        if marker == 0xFF:
            index += 1
            continue
        if marker in {0xD8, 0x01} or 0xD0 <= marker <= 0xD7:
            index += 2
            continue
        segment = struct.unpack(">H", data[index + 2:index + 4])[0]
        if segment < 2:
            raise Rejected("This JPEG file is malformed.")
        if marker in {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}:
            if index + 9 > length:
                raise Rejected("This JPEG file is malformed.")
            height, width = struct.unpack(">HH", data[index + 5:index + 9])
            return width, height
        if marker == 0xDA:
            break
        index += 2 + segment
    raise Rejected("This JPEG file has no frame header.")


def sniff(data: bytes, filename: str, declared: str | None) -> tuple[str, int | None, int | None]:
    """Decide the media type from bytes. Returns (media_type, width, height)."""
    if not data:
        raise Rejected("The file is empty.")
    media_type: str
    width = height = None
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        media_type = "image/png"
        width, height = png_dimensions(data)
    elif data.startswith(b"\xff\xd8\xff"):
        media_type = "image/jpeg"
        width, height = jpeg_dimensions(data)
    elif data.startswith(b"%PDF-"):
        if b"%%EOF" not in data[-2048:]:
            raise Rejected("This PDF file is incomplete.")
        media_type = "application/pdf"
    else:
        suffix = Path(filename).suffix.lower()
        if suffix not in TEXT_SUFFIXES:
            raise Rejected("Use a PNG, JPEG, PDF, TXT or Markdown file.")
        if b"\x00" in data:
            raise Rejected("This text file contains binary data.")
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise Rejected("Text files must be UTF-8.") from exc
        if len(text) > MAX_SOURCE_TEXT:
            raise Rejected(f"Text files must be at most {MAX_SOURCE_TEXT} characters.")
        media_type = TEXT_SUFFIXES[suffix]
    if width is not None and height is not None and (
        not 1 <= width <= MAX_DIMENSION or not 1 <= height <= MAX_DIMENSION or width * height > MAX_PIXELS
    ):
        raise Rejected(f"Images must be at most {MAX_DIMENSION} pixels per side and {MAX_PIXELS // 1_000_000} million pixels.")
    if declared:
        base = declared.split(";", 1)[0].strip().lower()
        expected = {media_type}
        if media_type == "text/markdown":
            expected = {"text/markdown", "text/plain", "text/x-markdown"}
        if base and base != "application/octet-stream" and base not in expected:
            raise Rejected(f"The file looks like {media_type}, not {base}.")
    return media_type, width, height


def stored_path(attachment_id: str, media_type: str) -> Path:
    return settings.assets_dir / f"{attachment_id}{EXTENSIONS[media_type]}"


async def read_capped(request: Request) -> bytes:
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > MAX_BYTES:
        raise HTTPException(413, "Files must be at most 1 MB.")
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > MAX_BYTES:
            raise HTTPException(413, "Files must be at most 1 MB.")
        chunks.append(chunk)
    return b"".join(chunks)


def store(db: Session, *, data: bytes, filename: str, media_type: str, width: int | None, height: int | None,
          topic_id: str, now: float) -> tuple[Attachment, Path]:
    attachment = Attachment(id=uuid4().hex, inbox_topic_id=topic_id, role="cover" if media_type in IMAGE_TYPES else "document",
                            filename=filename, media_type=media_type, size=len(data), sha256=hashlib.sha256(data).hexdigest(),
                            width=width, height=height, created_at=now)
    path = stored_path(attachment.id, media_type)
    settings.assets_dir.mkdir(parents=True, exist_ok=True)
    with open(path, "xb") as handle:
        handle.write(data)
    db.add(attachment)
    return attachment, path


@router.post("", status_code=201)
async def upload(request: Request,
                 title: str = Query(min_length=1, max_length=MAX_TITLE),
                 label: str | None = Query(default=None, min_length=1, max_length=MAX_LABEL),
                 filename: str = Query(default="", max_length=1024),
                 duration: int = Query(default=120, ge=15, le=3600)) -> dict:
    """Upload a file as a new Discover topic. Body: the raw file; type from bytes."""
    title = " ".join(title.split())
    label = " ".join(label.split()) if label is not None else None
    if not title or label == "":
        raise HTTPException(422, "Give the topic a title.")
    if label is not None:
        try:
            TopicIn(text=label, duration=duration)
        except ValidationError as exc:
            raise HTTPException(422, "The live label must be 1 to 30 characters.") from exc
    name = display_filename(filename)
    data = await read_capped(request)
    try:
        media_type, width, height = sniff(data, name, request.headers.get("content-type"))
    except Rejected as exc:
        raise HTTPException(422, str(exc)) from exc
    source_text = data.decode("utf-8") if media_type in {"text/plain", "text/markdown"} else ""
    path: Path | None = None
    try:
        with saved_transaction() as db:
            now = time.time()
            item = create_capture(db, kind="upload", title=title, label=label, note="", duration=duration,
                                  source_text=source_text, now=now)
            assert item.id is not None
            _, path = store(db, data=data, filename=name, media_type=media_type, width=width, height=height,
                            topic_id=item.id, now=now)
            db.flush()
            return full_detail(db, item)
    except BaseException:
        # The row and the file commit together; a failed commit leaves no file behind.
        if path is not None and path.exists():
            os.unlink(path)
        raise


def content_disposition(kind: str, filename: str) -> str:
    ascii_name = filename.encode("ascii", "ignore").decode().replace('"', "").strip() or "download"
    return f"{kind}; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(filename)}"


@router.get("/{attachment_id}")
def serve(attachment_id: str, download: bool = False) -> FileResponse:
    if not ID_PATTERN.fullmatch(attachment_id):
        raise HTTPException(404, "Attachment not found.")
    with saved_transaction() as db:
        row = db.get(Attachment, attachment_id)
        if row is None:
            raise HTTPException(404, "Attachment not found.")
        path = stored_path(row.id, row.media_type)
        if not path.is_file():
            raise HTTPException(404, "Attachment file is missing.")
        inline = row.role == "cover" and not download
        headers = {
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "private, max-age=3600",
            "Content-Security-Policy": "sandbox; default-src 'none'",
            "Content-Disposition": content_disposition("inline" if inline else "attachment", row.filename),
        }
        media_type = row.media_type if inline or row.media_type == "application/pdf" else "application/octet-stream"
        if row.media_type in {"text/plain", "text/markdown"}:
            media_type = "text/plain; charset=utf-8"
        return FileResponse(path, media_type=media_type, headers=headers)
