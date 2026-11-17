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
  "To present your answer, call data_show: it publishes one result in Data; in this conversation a chart is drawn in full and a table gets a compact Open in Data link. Earlier results remain in History. " +
  "To discuss or edit a saved query, call data_describe with its id, or with no arguments for the latest saved result and the result/table catalog. Latest does not identify the person's selected result; use the supplied id or clarify when ambiguous. " +
  "Update that result with data_show id and sql; omitted kind and chart settings stay unchanged. The person's SQL is visible below the result. Use these tools, not computer/UI automation, to read or change SQL. Never guess fields listed as omitted in a bounded result. " +
  "You can clean data with Python using your existing tools, save CSV/Parquet/JSON, then data_load and data_show; write no dashboard or chart JavaScript unless the person asks for a dashboard page.";

export const BUILT_IN_DATA_SYSTEM_PROMPT =
  " Data tools (your own DuckDB): data_load brings files, folders, URLs, databases and Google Sheets into tables; data_describe shows a table (target), a saved result's SQL and chart (id), or the latest result plus a catalog (no arguments); data_sql runs one statement and keeps its result; data_show presents one table or chart in Data with an Open in Data link here (older results stay in History); data_export writes csv, parquet, xlsx, png or svg. To change a result's SQL, read it with data_describe and pass its id and new sql to data_show, which updates it in place, keeping its chart settings. Latest is not necessarily the person's selected result: use a given id or clarify. Use Data tools, not computer or UI automation; after cleaning data in Python, load the output and data_show it, no dashboard code. Inspect unfamiliar tables before SQL; aggregate or filter before charting (at most 10,000 marks).";
