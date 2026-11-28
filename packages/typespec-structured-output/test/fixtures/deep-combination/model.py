from datetime import datetime
from enum import Enum
from typing import Generic, Optional, TypeVar, Union
from pydantic import BaseModel, Field

T = TypeVar("T")

class Point(BaseModel):
    """A geographic point."""
    lat: float
    lon: float

class Status(str, Enum):
    open = "open"
    closed = "closed"

class Event(BaseModel, Generic[T]):
    at: datetime = Field(description="When it happened.")
    payload: T
    tags: list[str]

class Venue(BaseModel):
    name: str
    location: Optional[Point]
    status: Status
    sub_venues: list["Venue"]

class Timeline(BaseModel):
    events: list[Event[Venue]]
    primary: Optional[Venue] = Field(default=None, description="The primary venue.")
    status_or_text: Union[Status, str]

ROOTS = [Timeline]
