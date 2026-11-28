from pydantic import BaseModel

class NamedBox(BaseModel):
    value: str

class Copy(BaseModel):
    created_by: str

class Record1(BaseModel):
    created_by: str
    box: NamedBox
    copy: Copy

ROOTS = [Record1]
