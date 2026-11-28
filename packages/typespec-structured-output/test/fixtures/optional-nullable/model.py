from typing import Annotated, Optional
from pydantic import BaseModel, Field

class Person(BaseModel):
    name: str
    nickname: Optional[str]
    age: Optional[Annotated[int, Field(ge=-2147483648, le=2147483647)]] = None
    tags: list[str]
    partner: Optional["Person"] = None

ROOTS = [Person]
