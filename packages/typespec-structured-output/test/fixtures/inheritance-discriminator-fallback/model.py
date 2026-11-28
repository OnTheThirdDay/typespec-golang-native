from typing import Annotated, Literal, Union
from typing_extensions import TypeAliasType
from pydantic import BaseModel, Field

class Cat(BaseModel):
    kind: Literal["cat"]
class Pet_Fallback(BaseModel):
    kind: Annotated[str, Field(pattern=r"^(?:|[^c][\s\S]*|c(?:|[^a][\s\S]*|a(?:|[^t][\s\S]*|t[\s\S][\s\S]*)))$")]
Pet = TypeAliasType("Pet", Union[Cat, Pet_Fallback])
class M(BaseModel):
    pet: Pet

ROOTS = [M]
