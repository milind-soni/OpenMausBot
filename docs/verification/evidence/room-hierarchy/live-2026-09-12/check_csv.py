import csv, io, json, re
from pathlib import Path
from datetime import date
root=Path(__file__).parent
report=json.loads((root/'transcripts.json').read_text(encoding='utf-8'))
room=next(t for t in report['transcripts'] if t['name']=='実装チーム')
msg=next(m for m in room['messages'] if m.get('from',{}).get('name')=='ヒナ' and '```' in m.get('text',''))
source=re.search(r'```(?:csv)?\n(.*?)\n```',msg['text'],re.S).group(1)
with (root/'sample.csv').open('w', encoding='utf-8', newline='') as output:
    output.write(source)
rows=list(csv.reader(io.StringIO(source),strict=True))
expected='受注番号,受注日,更新日,顧客コード,顧客名,担当者名,部署,商品名,数量,単価,金額,ステータス'.split(',')
checks={
 'header_matches_agreed_order': rows[0]==expected,
 'three_data_rows':len(rows)==4,
 'twelve_columns_every_row':all(len(r)==12 for r in rows),
 'consecutive_unique_ids':[r[0] for r in rows[1:]]==['ORD-000001','ORD-000002','ORD-000003'],
 'date_range_matches_assignment':all(date(2026,3,12)<=date.fromisoformat(r[1])<=date(2026,9,11) for r in rows[1:]),
 'update_on_or_after_order':all(date.fromisoformat(r[2])>=date.fromisoformat(r[1]) for r in rows[1:]),
 'integer_values_and_amount':all(all(re.fullmatch(r'\d+',v) for v in r[8:11]) and int(r[8])*int(r[9])==int(r[10]) for r in rows[1:]),
 'allowed_status':all(r[11] in ['確定','出荷済','完了','キャンセル'] for r in rows[1:]),
 'no_embedded_commas_quotes_or_newlines':all(not any(c in value for c in ',"\r\n') for r in rows for value in r),
}
result={'sourceMessageId':msg['id'],'sourceAuthor':'ヒナ','checks':checks,'allPassed':all(checks.values()),'limits':['Checks apply to extracted chat text, not a bot-created file.','Chat block has no BOM; UTF-8 BOM file output is not verified.','Date interval follows the assignment; cross-team agreement is assessed separately.']}
with (root/'csv-checks.json').open('w', encoding='utf-8', newline='\n') as output:
    output.write(json.dumps(result,ensure_ascii=False,indent=2))
print(json.dumps(result,ensure_ascii=False,indent=2))
assert result['allPassed']
