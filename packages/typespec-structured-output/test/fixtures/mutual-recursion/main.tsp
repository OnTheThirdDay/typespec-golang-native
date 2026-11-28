import "typespec-structured-output";
using StructuredOutput;

model Folder { name: string; entries: Entry[]; }
model File { name: string; size: int64; }
union Entry { folder: Folder, file: File }
@structuredOutput
model Drive { root: Folder; parent: Drive | null; }
