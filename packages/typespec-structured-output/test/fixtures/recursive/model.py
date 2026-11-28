from pydantic import BaseModel

class TreeNode(BaseModel):
    label: str
    children: list["TreeNode"]

ROOTS = [TreeNode]
