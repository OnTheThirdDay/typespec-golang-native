# Port of openai-python tests/lib/test_pydantic.py::test_enums (Apache-2.0)
from enum import Enum
from pydantic import BaseModel, Field

class Color(Enum):
    RED = "red"
    BLUE = "blue"
    GREEN = "green"

class ColorDetection(BaseModel):
    color: Color = Field(description="The detected color")
    hex_color_code: str = Field(description="The hex color code of the detected color")

ROOTS = [ColorDetection]
