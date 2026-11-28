from typing import Annotated, Literal, Optional, Union
from pydantic import BaseModel, Field

class Cat(BaseModel):
    kind: Literal["cat"]
    lives: Annotated[int, Field(ge=-128, le=127)]

class Dog(BaseModel):
    kind: Literal["dog"]
    good: bool

Pet = Union[Cat, Dog]

class Household(BaseModel):
    pet: Pet
    maybe: Optional[Union[Cat, Dog]]
    value: Union[str, float]

ROOTS = [Household]
