# Pydantic merges colliding definitions whose schemas are identical.
from pydantic import BaseModel

class Tag(BaseModel):
    __module__ = "One"
    name: str
OneTag = Tag

class Tag(BaseModel):
    __module__ = "Two"
    name: str
TwoTag = Tag

class Tagged(BaseModel):
    a: OneTag
    b: TwoTag

ROOTS = [Tagged]
