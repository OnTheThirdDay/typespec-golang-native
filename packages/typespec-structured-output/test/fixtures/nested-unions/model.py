from typing import Literal, Optional, Union
from pydantic import BaseModel

class A(BaseModel):
    a: str

class B(BaseModel):
    b: str

class C(BaseModel):
    c: str

class Holder(BaseModel):
    flat: Union[A, B, C]
    nullable_nested: Optional[Union[A, B, C]]
    literal_mix: Union[Literal["x", "y"], A]
    bools: Literal[True, False]
    floats: Literal[1.5, 2.5]
    single: Literal[True]
    optional_literal: Optional[Literal["on", "off"]] = None

ROOTS = [Holder]
