import "typespec-structured-output";
using StructuredOutput;

// Port of openai-python tests/lib/schema_types/query.py (test_most_types)
enum Table { orders, customers, products }
enum Column { id, status, expected_delivery_date, delivered_at, shipped_at, ordered_at, canceled_at }
enum Operator { eq: "=", gt: ">", lt: "<", le: "<=", ge: ">=", ne: "!=" }
enum OrderBy { asc, desc }
model DynamicValue { column_name: string; }
model Condition { column: string; operator: Operator; value: string | integer | DynamicValue; }
@structuredOutput
model Query {
  name?: string | null;
  table_name: Table;
  columns: Column[];
  conditions: Condition[];
  order_by: OrderBy;
}
