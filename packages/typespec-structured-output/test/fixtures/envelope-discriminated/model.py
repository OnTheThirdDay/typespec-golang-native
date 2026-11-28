from pydantic import BaseModel
from typing import Literal

class A(BaseModel):
    x: str

class B(BaseModel):
    y: str

class U_a(BaseModel):
    kind: Literal["a"]
    value: A

class U_b(BaseModel):
    kind: Literal["b"]
    value: B

class M(BaseModel):
    u: U_a | U_b

ROOTS = [M]
