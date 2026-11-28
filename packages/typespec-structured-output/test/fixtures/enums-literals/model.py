from enum import Enum
from typing import Literal, Optional
from pydantic import BaseModel

class Color(str, Enum):
    """Primary colors."""
    red = "red"
    green = "grn"
    blue = "blue"

class Paint(BaseModel):
    color: Color
    finish: Literal["matte", "gloss"]
    kind: Literal["paint"]
    shade: Optional[Color] = None
    level: Literal[1, 2, 3]

ROOTS = [Paint]
