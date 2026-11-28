from pydantic import BaseModel, Field


class Child𐐀(BaseModel):
    value: str


class Labels(BaseModel):
    child: Child𐐀
    item0: str = Field(alias="\u00dfeta")
    item1: str = Field(alias="\u01f3one")
    item2: str = Field(alias="\u039f\u03a3")
    item3: str = Field(alias="\u1f80\u03bb\u03c6\u03b1")
    item4: str = Field(alias="\u10e5\u10d0\u10e0\u10d7\u10e3\u10da\u10d8")
    item5: str = Field(alias="\u0085wrapped\u0085")
    item6: str = Field(alias="\ufeffkept")
    item7: str = Field(alias="10")
    item8: str = Field(alias="2")
    item9: str = Field(alias="\u02b0Hello")


ROOTS = [Labels]
