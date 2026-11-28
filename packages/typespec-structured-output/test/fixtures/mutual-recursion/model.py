from typing import Annotated, Optional, Union
from pydantic import BaseModel, Field

class File(BaseModel):
    name: str
    size: Annotated[int, Field(ge=-9223372036854775808, le=9223372036854775807)]

class Folder(BaseModel):
    name: str
    entries: list[Union["Folder", File]]

class Drive(BaseModel):
    root: Folder
    parent: Optional["Drive"]

ROOTS = [Drive]
