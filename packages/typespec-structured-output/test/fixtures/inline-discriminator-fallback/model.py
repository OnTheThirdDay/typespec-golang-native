from typing import Annotated, Literal, Union
from pydantic import BaseModel, Field

class A(BaseModel):
    kind: Literal["a"]
    x: str
class U_Fallback(BaseModel):
    kind: Annotated[str, Field(pattern=r"^(?:|[^a][\s\S]*|a[\s\S][\s\S]*)$")]
class M(BaseModel):
    u: Union[A, U_Fallback]

ROOTS = [M]
