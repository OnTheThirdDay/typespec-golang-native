from pydantic import BaseModel, Field

class M(BaseModel):
    head: str
    one: str = Field(alias="1")
    proto: str = Field(alias="__proto__")
    zero: int = Field(alias="0")

ROOTS = [M]
