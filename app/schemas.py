"""Validation of the `instructions` JSON document (schema_version 1.0)."""
import json
from typing import Annotated, List, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

SUPPORTED_OPS = {"shorten_segment", "cut_range", "reframe", "overlay_text", "captions"}


class InstructionError(Exception):
    def __init__(self, status: int, body: dict):
        self.status, self.body = status, body


class _Base(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ShortenSegment(_Base):
    op: Literal["shorten_segment"]
    segment: Literal["intro", "outro"]
    target_duration_s: float = Field(gt=0, le=3600)
    segment_end_s: Optional[float] = Field(default=None, ge=0)    # intro only: where the intro ends
    segment_start_s: Optional[float] = Field(default=None, ge=0)  # outro only: where the outro starts
    detect: Literal["scene_change"] = "scene_change"
    keep: Optional[Literal["first", "last"]] = None  # default: intro=last, outro=first
    scene_threshold: float = Field(default=0.4, ge=0.05, le=0.95)

    @model_validator(mode="after")
    def _check(self):
        if self.segment == "intro" and self.segment_start_s is not None:
            raise ValueError("segment_start_s is only valid for segment='outro'")
        if self.segment == "outro" and self.segment_end_s is not None:
            raise ValueError("segment_end_s is only valid for segment='intro'; use segment_start_s for the outro")
        return self


class CutRange(_Base):
    op: Literal["cut_range"]
    start: float = Field(ge=0)
    end: float = Field(gt=0)

    @model_validator(mode="after")
    def _check(self):
        if self.end <= self.start:
            raise ValueError("end must be greater than start")
        return self


class Reframe(_Base):
    op: Literal["reframe"]
    aspect: Literal["9:16"]
    mode: Literal["crop", "pad"] = "crop"


Style = Literal["bold-yellow", "white-box", "plain"]


class OverlayText(_Base):
    op: Literal["overlay_text"]
    text: str = Field(min_length=1, max_length=200)
    at: float = Field(ge=0)
    duration: float = Field(gt=0, le=60)
    style: Style = "bold-yellow"
    max_words_per_line: int = Field(default=4, ge=1, le=12)


class CaptionSegment(_Base):
    start: float = Field(ge=0)
    end: float = Field(gt=0)
    text: str = Field(min_length=1, max_length=200)

    @model_validator(mode="after")
    def _check(self):
        if self.end <= self.start:
            raise ValueError("caption end must be greater than start")
        return self


class Captions(_Base):
    op: Literal["captions"]
    source: Literal["manual", "auto_transcribe"]
    style: Style = "bold-yellow"
    max_words_per_line: int = Field(default=4, ge=1, le=12)
    segments: Optional[List[CaptionSegment]] = Field(default=None, max_length=200)

    @model_validator(mode="after")
    def _check(self):
        if self.source == "manual" and not self.segments:
            raise ValueError("source='manual' requires a non-empty 'segments' list")
        return self


Operation = Annotated[Union[ShortenSegment, CutRange, Reframe, OverlayText, Captions], Field(discriminator="op")]


class Instructions(_Base):
    schema_version: Literal["1.0"]
    video_id: Optional[str] = Field(default=None, max_length=100)
    base_version: Optional[str] = Field(default=None, max_length=100)
    reviewer_comment: Optional[str] = Field(default=None, max_length=2000)
    comment_timestamp_s: Optional[float] = Field(default=None, ge=0)
    operations: List[Operation] = Field(min_length=1, max_length=20)


def parse_instructions(raw: str) -> Instructions:
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        raise InstructionError(422, {"error": "invalid_json",
                                     "message": f"instructions is not valid JSON: {e.msg} (line {e.lineno}, column {e.colno})"})
    if not isinstance(data, dict):
        raise InstructionError(422, {"error": "invalid_instructions", "message": "instructions must be a JSON object"})
    ops = data.get("operations")
    if isinstance(ops, list):
        bad: List[str] = []
        for o in ops:
            name = o.get("op") if isinstance(o, dict) else None
            if isinstance(name, str) and name not in SUPPORTED_OPS and name not in bad:
                bad.append(name)
        if bad:
            raise InstructionError(422, {"error": "unsupported_operation", "operations": bad,
                                         "message": "Supported operations: " + ", ".join(sorted(SUPPORTED_OPS))})
    try:
        ins = Instructions.model_validate(data)
    except ValidationError as e:
        details = [{"loc": ".".join(str(x) for x in err["loc"]), "msg": err["msg"]} for err in e.errors()]
        raise InstructionError(422, {"error": "invalid_instructions", "details": details})
    if any(isinstance(o, Captions) and o.source == "auto_transcribe" for o in ins.operations):
        raise InstructionError(422, {"error": "unsupported_operation", "operations": ["captions"],
                                     "message": "captions with source='auto_transcribe' is not supported (no speech-to-text in this service). "
                                                "Use source='manual' with segments, or overlay_text."})
    return ins
