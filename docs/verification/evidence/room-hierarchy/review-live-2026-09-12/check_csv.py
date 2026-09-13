"""Check the actual draft CSV separately from the later eight-column decision."""
import csv
import io
import json
import re
from datetime import date
from pathlib import Path

root = Path(__file__).parent
report = json.loads((root / 'transcripts.json').read_text(encoding='utf-8'))
room = next(t for t in report['transcripts'] if t['name'] == '実装チーム')
message = next(m for m in room['messages']
               if m.get('from', {}).get('name') == 'ヒナ' and '```csv' in m.get('text', ''))
source = re.search(r'```csv\n(.*?)\n```', message['text'], re.S).group(1)
with (root / 'sample.csv').open('w', encoding='utf-8', newline='') as output:
    output.write(source)
rows = list(csv.reader(io.StringIO(source), strict=True))
header = '顧客名,契約ID,契約日,担当営業,商談ステータス,受注金額,失注理由'.split(',')
reasons = {'価格', '機能不足', '競合選択', 'タイミング', '決裁権者未了', 'その他'}
checks = {
    'matches_implementation_draft_header': rows[0] == header,
    'five_data_rows': len(rows) == 6,
    'seven_columns_each_row': all(len(r) == 7 for r in rows),
    'dates_in_draft_interval': all(date(2026, 6, 12) <= date.fromisoformat(r[2]) <= date(2026, 9, 12) for r in rows[1:]),
    'both_date_boundaries_present': {'2026-06-12', '2026-09-12'} <= {r[2] for r in rows[1:]},
    'unique_contract_ids': len({r[1] for r in rows[1:]}) == 5,
    'masked_names_with_distinct_embedded_customer_ids': all(re.fullmatch(r'.?■ C\d{5}', r[0]) for r in rows[1:]) and len({r[0].split()[-1] for r in rows[1:]}) == 5,
    'statuses_and_conditional_loss_reasons': {r[4] for r in rows[1:]} == {'商談中', '受注', '失注'} and all((r[6] in reasons if r[4] == '失注' else r[6] == '') for r in rows[1:]),
    'integer_amounts_or_empty_for_lost_deals': all((r[5] == '' if r[4] == '失注' else bool(re.fullmatch(r'\d+', r[5]))) for r in rows[1:]),
}
result = {
    'sourceMessageId': message['id'], 'sourceAuthor': 'ヒナ',
    'draftChecks': checks, 'draftChecksPassed': all(checks.values()),
    'finalAcceptance': {
        'expectedColumns': 8, 'actualColumns': len(rows[0]),
        'separateCustomerIdColumn': '顧客ID' in rows[0],
        'passesFinalColumnContract': len(rows[0]) == 8 and '顧客ID' in rows[0],
    },
    'limits': ['Extracted chat text, not a bot-created file.',
               'Passing draft checks does not satisfy the later eight-column decision.',
               'No file-byte, runtime export, or production-readiness claim.'],
}
with (root / 'csv-checks.json').open('w', encoding='utf-8', newline='\n') as output:
    output.write(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(result, ensure_ascii=False, indent=2))
assert result['draftChecksPassed']
# This historical run must reproduce the recorded final-contract failure too.
assert not result['finalAcceptance']['passesFinalColumnContract']
