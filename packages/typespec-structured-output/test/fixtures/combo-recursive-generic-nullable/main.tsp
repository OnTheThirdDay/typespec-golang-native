import "typespec-structured-output";
using StructuredOutput;

model Comment {
  /** Author name. */
  author: string;
  replies: Comment[];
  parent: Comment | null;
}
model Thread<T> {
  root: T;
  pinned: T | null;
  tags: (string | null)[];
}
@structuredOutput
model Discussion {
  thread: Thread<Comment>;
  /** Alternative thread. */
  alt?: Thread<Comment> | null;
  scores: (int32 | float64 | null)[][];
}
