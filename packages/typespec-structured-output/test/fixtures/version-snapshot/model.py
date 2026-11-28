from pydantic import BaseModel

class M(BaseModel):
    a: str

ROOTS = [M]
