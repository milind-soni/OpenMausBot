// The Data server's `instructions`: the DuckDB dialect in one paragraph,
// sent once with the server (initialize and tools/list) instead of repeated
// in every tool description. Dialect mistakes are a knowledge gap, not a
// reasoning gap (research/03-tools.md), so this is the cheapest fix there is.
// No imports: harness-mcp-proxy bundles this file into the agent process.

export const DATA_INSTRUCTIONS =
  "The Data tools run DuckDB SQL on this bot's own database; results appear on the Data tab beside the chat. " +
  "Dialect: double quotes name identifiers (\"Order Date\"), single quotes make strings ('2024-01-01'); identifiers are case-insensitive. " +
  "GROUP BY ALL groups by every non-aggregated column; QUALIFY filters window results; SELECT * EXCLUDE (col) and COLUMNS('re.*') pick columns; PIVOT/UNPIVOT reshape. " +
  "Dates: date_trunc('month', d), time_bucket(INTERVAL '1 week', ts), strftime(d, '%Y-%m'), d::DATE, try_cast(x AS DOUBLE), today(), now(). " +
  "Strings and lists are 1-based (substr, list[1]); sum() of an empty group is NULL; -2^2 is 4; x IN (0, NULL) is NULL when no match. " +
  "Read files directly: read_csv('a.csv'), read_parquet('dir/*.parquet'), read_json_auto('x.ndjson'), read_xlsx('b.xlsx', sheet='S'); " +
  "SUMMARIZE tbl, DESCRIBE tbl and SHOW TABLES describe what is loaded. " +
  "Run data_describe before writing SQL against a table; aggregate or filter in SQL before charting; one statement per call. " +
  "To present your answer, call data_show: it publishes one result in Data and a compact Open in Data link in this conversation. Earlier results remain in History. " +
  "To discuss or edit a saved query, call data_describe with its id, or with no arguments for the latest saved result and the result/table catalog. Latest does not identify the person's selected result; use the supplied id or clarify when ambiguous. " +
  "Update that result with data_show id and sql; omitted kind and chart settings stay unchanged. The person's SQL is visible below the result. Use these tools, not computer/UI automation, to read or change SQL. Never guess fields listed as omitted in a bounded result. " +
  "You can clean data with Python using your existing tools, save CSV/Parquet/JSON, then data_load and data_show; do not build a dashboard or write chart JavaScript.";

/** The system-prompt section a turn gets when the Data tools are mounted,
 * beside the browser's. Short: the dialect lives in DATA_INSTRUCTIONS. */
export const BUILT_IN_DATA_SYSTEM_PROMPT =
  " You have Data tools backed by your own DuckDB database: data_load brings files, folders, URLs, databases and Google Sheets into named tables; data_describe with target shows table columns and samples, with id reads a saved result's current SQL/chart, and with no arguments reads the latest saved result plus a compact catalog; data_sql runs one SQL statement and keeps its result; data_show presents one table or chart in Data and an Open in Data link in this conversation, with earlier results in History and SQL below the result; data_export writes csv, parquet, xlsx, png or svg. To discuss or change SQL, read the existing result with data_describe, then pass its id and new sql to data_show to update in place while retaining its chart settings. Latest is not necessarily the person's selected result: use a supplied id or clarify ambiguity. Use Data tools, not computer/UI automation. After cleaning data with Python, load its output and call data_show; no dashboard code is needed. Inspect unfamiliar tables before writing SQL, and aggregate or filter before charting (at most 10,000 marks).";
