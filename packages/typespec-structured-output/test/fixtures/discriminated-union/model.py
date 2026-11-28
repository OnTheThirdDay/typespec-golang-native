# Profile convention: a @discriminated(envelope "none") union maps to the plain Union of its
# tagged variants. (Field(discriminator=...) yields `oneOf`, which OpenAI rejects.)
from typing import Literal, Optional, Union
from pydantic import BaseModel

class Circle(BaseModel):
    shape: Literal["circle"]
    radius: float

class Rect(BaseModel):
    shape: Literal["rect"]
    width: float
    height: float

Shape = Union[Circle, Rect]

class Drawing(BaseModel):
    shapes: list[Shape]
    primary: Optional[Shape]

ROOTS = [Drawing]
