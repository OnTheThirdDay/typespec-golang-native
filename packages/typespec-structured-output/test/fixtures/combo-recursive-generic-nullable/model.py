from typing import Annotated, Generic, Optional, TypeVar, Union
from pydantic import BaseModel, Field

T = TypeVar("T")

class Comment(BaseModel):
    author: str = Field(description="Author name.")
    replies: list["Comment"]
    parent: Optional["Comment"]

class Thread(BaseModel, Generic[T]):
    root: T
    pinned: Optional[T]
    tags: list[Optional[str]]

class Discussion(BaseModel):
    thread: Thread[Comment]
    alt: Optional[Thread[Comment]] = Field(default=None, description="Alternative thread.")
    scores: list[list[Optional[Union[Annotated[int, Field(ge=-2147483648, le=2147483647)], float]]]]

ROOTS = [Discussion]
