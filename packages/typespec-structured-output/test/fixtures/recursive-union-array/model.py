from typing import Union
from typing_extensions import TypeAliasType
from pydantic import BaseModel

Tree = TypeAliasType("Tree", Union[str, list["Tree"]])
class Forest(BaseModel):
    root: Tree
    maybe: Tree | None

ROOTS = [Forest]
