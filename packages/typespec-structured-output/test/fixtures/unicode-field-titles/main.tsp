import "typespec-structured-output";
using StructuredOutput;

model Child𐐀 { value: string; }

@structuredOutput model Labels {
  child: Child𐐀;
  @encodedName("application/json", "ßeta") item0: string;
  @encodedName("application/json", "ǳone") item1: string;
  @encodedName("application/json", "ΟΣ") item2: string;
  @encodedName("application/json", "ᾀλφα") item3: string;
  @encodedName("application/json", "ქართული") item4: string;
  @encodedName("application/json", "wrapped") item5: string;
  @encodedName("application/json", "﻿kept") item6: string;
  @encodedName("application/json", "10") item7: string;
  @encodedName("application/json", "2") item8: string;
  @encodedName("application/json", "ʰHello") item9: string;
}
