# Port of openai-python tests/lib/test_pydantic.py::test_nested_inline_ref_expansion (Apache-2.0)
from pydantic import BaseModel, Field

class Star(BaseModel):
    name: str = Field(description="The name of the star.")

class Galaxy(BaseModel):
    name: str = Field(description="The name of the galaxy.")
    largest_star: Star = Field(description="The largest star in the galaxy.")

class Universe(BaseModel):
    name: str = Field(description="The name of the universe.")
    galaxy: Galaxy = Field(description="A galaxy in the universe.")

ROOTS = [Universe]
