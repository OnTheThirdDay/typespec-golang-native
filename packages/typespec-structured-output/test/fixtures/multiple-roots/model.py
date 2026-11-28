from pydantic import BaseModel

class Shared(BaseModel):
    x: str

class First(BaseModel):
    s: Shared

class Second(BaseModel):
    s: Shared
    n: int

ROOTS = [First, Second]
