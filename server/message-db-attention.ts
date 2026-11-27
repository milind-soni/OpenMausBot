export function attentionSelect(multiExecuteInput: string): string {
  return "SELECT thread_id AS threadId, id, at, kind, json_extract(json, '$.from.botId') AS fromBotId, json_extract(json, '$.digest.botId') AS digestBotId, " +
    "json_extract(json, '$.tool.name') AS name, json_extract(json, '$.tool.setup') AS setup, json_extract(json, '$.tool.place') AS place, " +
    "json_extract(json, '$.tool.nameCode') AS nameCode, json_extract(json, '$.tool.nameParams') AS nameParams, " +
    `substr(json_extract(json, '$.tool.output'), 1, 2000) AS output, ${multiExecuteInput}, ` +
    "CASE WHEN kind = 'options' THEN json_extract(json, '$.card') END AS card";
}
