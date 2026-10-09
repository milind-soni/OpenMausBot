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
  "Run data_describe before writing SQL against a table; aggregate or filter in SQL before charting; one statement per call.";

/** The system-prompt section a turn gets when the Data tools are mounted,
 * beside the browser's. Short: the dialect lives in DATA_INSTRUCTIONS. */
export const BUILT_IN_DATA_SYSTEM_PROMPT =
  " You have Data tools backed by your own DuckDB database: data_load brings files, folders, URLs, databases and Google Sheets into named tables; data_describe shows a table's columns with sample values; data_sql runs one SQL statement and keeps its result; data_show puts a table or a chart on the Data tab, where the person sees every card with its SQL and can edit or export it; data_export writes csv, parquet, xlsx, png or svg. Call data_describe before writing SQL against a table you have not seen, and aggregate or filter in SQL before charting (a chart draws at most 10,000 marks). To change what the person sees, pass the card's id to data_show instead of adding another card.";
