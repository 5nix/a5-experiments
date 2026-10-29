"""从Word原文与内嵌Excel生成文本表格，应用经用户批准的独立文案修订；追加V2新增的SH06、SH07与U2内休息配置；生成眼镜消息stimuli.json。"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
raw = json.loads((ROOT / 'content/source/task-document.json').read_text())
blocks = {b['block_index']: b for b in raw['blocks']}
revisions = json.loads((ROOT / 'content/revisions.json').read_text())
embedded = json.loads((ROOT / 'content/source/embedded-workbooks.json').read_text())
workbooks = {int(re.search(r'Worksheet(\d+)', w['source_member']).group(1)): w for w in embedded['workbooks']}


v2 = revisions['v2_stages']
rest = revisions['rest_settings']


def paragraphs(*indexes):
    # V2覆盖（如导入页“七个不同阶段”）优先于M1—M6修订，再回退到Word原文。
    return [v2['intro_paragraph_overrides'].get(str(i), revisions['paragraph_overrides'].get(str(i), blocks[i]['text'])) for i in indexes]


def source(*indexes):
    return {'file': 'A5 SH任务pilot.docx', 'block_indexes': list(indexes), 'revision_id': revisions['revision_id']}


def table(n, title):
    workbook = workbooks[n]
    sheet = workbook['sheets'][0]
    cells = sheet['cells']
    columns = max(sum((ord(c) - 64) * 26 ** i for i, c in enumerate(re.match(r'[A-Z]+', key).group()[::-1])) for key in cells)
    last_row = max(int(re.search(r'\d+', key).group()) for key in cells)
    def row(index):
        return [cells.get(f'{chr(65 + col)}{index}', {}).get('display', '') for col in range(columns)]
    header = 2 if sum(bool(v) for v in row(1)) == 1 and any(m.startswith('A1:') for m in sheet['merged_ranges']) else 1
    value = {'id': f'table-{n:02}', 'caption': row(1)[0] if header == 2 else title,
            'columns': row(header), 'rows': [row(i) for i in range(header + 1, last_row + 1)],
            'source_ref': {'file': 'A5 SH任务pilot.docx', 'embedded_file': workbook['source_member'], 'sheet': sheet['name'], 'range': f'A{header}:{chr(64 + columns)}{last_row}', 'sha256': workbook['sha256']}}
    override = revisions['work_style'].get('table_overrides', {}).get(value['id'])
    if override:
        value.update(override)
        value['source_ref']['wording_revision_id'] = revisions['work_style']['revision_id']
    return value


def field(id, label, type='integer', options=None, exclusive=None):
    value = {'id': id, 'label': label, 'type': type, 'required': True}
    if options:
        value['options'] = [{'value': v, 'label': t} for v, t in options]
    if exclusive:
        value['exclusive_value'] = exclusive
    return value


plans = [(v, v) for v in 'ABCD'] + [('NONE', '没有合格方案')]
people = ['林晨', '周悦', '陈珂', '许宁', '唐可', '赵禾']
substitutes = [(v, v) for v in ['王帆', '唐可', '赵禾', '顾然']] + [('NONE', '无人可纳入')]


def choices():
    return field('plans', '合格方案', 'multi', plans, 'NONE')


def schedule_fields():
    return [field('debug', '设备调试最早可开始的时间', 'time'), field('training', '讲解培训最早可开始的时间', 'time'),
            field('acceptance', '现场验收最早可开始的时间', 'time'), field('on_time', '能否在12:00前完成验收？', 'single', [('能', '能'), ('不能', '不能')])]


def staffing_fields(names):
    return [field(id, label, 'single', [(n, n) for n in names]) for id, label in [('checkin', '签到'), ('guide', '现场引导'), ('equipment', '设备管理')]]


def staffing(updated=False):
    qualifications = [['签到', '现场引导'], ['签到', '设备管理'], ['现场引导', '设备管理'], ['签到'], ['现场引导'], ['设备管理']]
    times = ['12:40', '12:50', '13:05', '12:55', '13:10', '12:45']
    personnel = [{'name': n, 'qualifications': q, 'arrival': t, 'absent': updated and n == '周悦'}
                 for n, q, t in zip(people, qualifications, times)]
    if updated:
        personnel[-1]['arrival'] = '13:10'
        personnel.append({'name': '梁欣', 'qualifications': ['现场引导', '设备管理'], 'arrival': '12:55', 'absent': False})
    return {'type': 'staffing', 'positions': {'checkin': {'qualification': '签到', 'start': '13:00'}, 'guide': {'qualification': '现场引导', 'start': '13:15'}, 'equipment': {'qualification': '设备管理', 'start': '13:00'}}, 'personnel': personnel,
            'source_ref': {'file': 'A5 SH任务pilot.docx', 'embedded_workbooks': [11, 12, 13] if not updated else [14, 15]}}


work = revisions['work_style']


def unit(stage, number, title, indexes, tables, fields, scoring, reveal=None):
    unit_id = f'{stage}_U{number}'
    # 使用用户逐项指定的任务文案；原句和原始表格保留在source与archive。
    value = {'unit_id': unit_id, 'title': work.get('unit_titles', {}).get(unit_id, blocks[title]['text']), 'paragraphs': work['unit_paragraphs'].get(unit_id, paragraphs(*indexes)),
             'tables': tables, 'assets': [], 'fields': fields, 'scoring': scoring,
             'source_ref': {**source(title, *indexes), 'wording_revision_id': work['revision_id']}}
    for answer_field in value['fields']:
        answer_field['label'] = work.get('field_labels', {}).get(unit_id, {}).get(answer_field['id'], answer_field['label'])
    value['scratchpad'] = {'label': '草稿本', 'placeholder': work['scratchpad_placeholder'], 'max_length': 20000}
    if reveal:
        value['reveal'] = {**reveal, 'button_label': work['reveal_labels'].get(unit_id, reveal['button_label'])}
        if unit_id in work.get('reveal_paragraphs', {}):
            value['reveal']['paragraphs'] = work['reveal_paragraphs'][unit_id]
    return value


def exact(expected, answer_block):
    return {'type': 'exact', 'expected': expected, 'source_ref': source(answer_block)}


units = [
    [unit('SH01', 1, 16, [17, 19], [table(1, '方案报价表')], [choices()], exact({'plans': ['A', 'B']}, 25),
          {'button_label': '查看方案筹备日期表', 'paragraphs': [], 'tables': [table(2, '方案筹备日期表')]}),
     unit('SH01', 2, 26, [27, 30, 33], [table(3, '更新后的完整方案数据')],
          [field(v, f'{v} 最终费用（万元）', 'money') for v in 'ABD'] + [choices()],
          exact({'A': '5.04', 'B': '4.89', 'D': '4.88', 'plans': ['B', 'D']}, 39))],
    [unit('SH02', 1, 44, [45, 46, 48], [table(4, '工作环节与时长的对应')], schedule_fields(),
          exact({'debug': '9:45', 'training': '10:45', 'acceptance': '11:15', 'on_time': '能'}, 54),
          {'button_label': '查看人员时间安排', 'paragraphs': [], 'tables': [table(5, '人员时间安排')]}),
     unit('SH02', 2, 55, [56, 59], [table(6, '更新后的准备日程资料')], schedule_fields()[1:],
          exact({'training': '11:00', 'acceptance': '11:45', 'on_time': '不能'}, 65))],
    [unit('SH03', 1, 69, [70, 72], [table(7, '待确认人员信息')],
          [field('total', '当前有效确认总人数（人）'), field('gap', '还需补充（人）')], exact({'total': 20, 'gap': 4}, 77),
          {'button_label': '查看人员的确认状态', 'paragraphs': [], 'tables': [table(8, '人员的确认状态')]}),
     unit('SH03', 2, 78, [79, 82, 85, 87], [table(9, '待确认人员信息'), table(10, '替补人员信息')],
          [field('substitutes', '应纳入的替补人员', 'multi', substitutes, 'NONE'), field('total', '有效确认总人数（人）'), field('gap', '仍缺（人）')],
          exact({'substitutes': ['王帆', '赵禾'], 'total': 23, 'gap': 1}, 92))],
    [unit('SH04', 1, 96, [97, 99], [table(11, '岗位工作时间'), table(12, '人员岗位资格')], staffing_fields(people), staffing(),
          {'button_label': '查看人员的到岗时间', 'paragraphs': [], 'tables': [table(13, '人员到岗时间安排')]}),
     unit('SH04', 2, 106, [107, 109], [table(14, '岗位工作时间'), table(15, '更新后的人员资格及到岗时间')], staffing_fields(people + ['梁欣']), staffing(True))],
    [unit('SH05', 1, 119, [120, 122], [table(16, '已有库存数')],
          [field(f'{item}_{kind}', f'{label}：{description}（张）') for item, label in [('badge', '胸牌'), ('guide', '活动指南'), ('record', '体验记录表')]
           for kind, description in [('available', '实际可用数量'), ('gap', '需要补充的数量')]],
          exact({'badge_available': 26, 'badge_gap': 4, 'guide_available': 32, 'guide_gap': 0, 'record_available': 44, 'record_gap': 7}, 130),
          {'button_label': '查看配套规则', 'paragraphs': [p['text'] for p in blocks[121]['rows'][0][1]['paragraphs'] if p['text']], 'assets': [], 'source_ref': source(121)}),
     unit('SH05', 2, 131, [132, 133, 135, 137, 138], [table(17, '原库存数'), table(18, '补充方案')],
          [field('plan', '补充方案', 'single', plans[:4]), field('badge_surplus', '多出胸牌（张）', 'integer_or_na'), field('record_surplus', '多出体验记录表（张）', 'integer_or_na')],
          exact({'plan': 'D', 'badge_surplus': 1, 'record_surplus': 3}, 143))],
]
def v2_source(**extra):
    return {'file': v2['source_ref']['file'], 'date': v2['source_ref']['date'], 'section': v2['source_ref']['section'], 'revision_id': v2['revision_id'], **extra}


def v2_unit(spec):
    # V2新增组（SH06、SH07）的内容来自revisions.v2_stages，结构与SH01—SH05生成结果一致。
    unit_id = spec['unit_id']
    tables = [{**t, 'source_ref': v2_source(unit_id=unit_id)} for t in spec['tables']]
    fields = [field(f['id'], f['label'], f['type'], [(o['value'], o['label']) for o in f.get('options', [])] or None, f.get('exclusive_value')) for f in spec['fields']]
    expected = {k: sorted(v) if isinstance(v, list) else v for k, v in spec['expected'].items()}
    value = {'unit_id': unit_id, 'title': spec['title'], 'paragraphs': spec['paragraphs'], 'tables': tables, 'assets': [], 'fields': fields,
             'scoring': {'type': 'exact', 'expected': expected, 'source_ref': v2_source(unit_id=unit_id, item='answers')},
             'source_ref': v2_source(unit_id=unit_id),
             'scratchpad': {'label': '草稿本', 'placeholder': work['scratchpad_placeholder'], 'max_length': 20000}}
    if 'reveal' in spec:
        value['reveal'] = {'button_label': spec['reveal']['button_label'], 'paragraphs': spec['reveal']['paragraphs'], 'assets': [],
                           'source_ref': v2_source(unit_id=unit_id, item=spec['reveal']['button_label'])}
    return value


def v2_stage(spec):
    assert not spec['card'].startswith('现在'), spec['card']
    return {'stage_id': spec['stage_id'], 'title': spec['title'], 'card': spec['card'], 'scene_time': spec['scene_time'],
            'source_ref': v2_source(), 'units': [v2_unit(u) for u in spec['units']]}


def scene_time(card):
    # 说明卡中的情景时间，供被试端任务栏时钟固定显示（不走动），文字取自原卡片。
    match = re.match(r'现在的时间是：(\d+月\d+日 周.) (\d{1,2}:\d{2})', card)
    assert match, card
    return {'date': match.group(1), 'time': match.group(2)}


data = {
    'schema_version': '1.3', 'content_version': 'sh-v2-2026-10-26-v12', 'revision_id': revisions['revision_id'], 'wording_revision_id': work['revision_id'], 'v2_revision_id': v2['revision_id'],
    'intro': {'title': '情景导入', 'paragraphs': paragraphs(6, 7), 'source_ref': source(6, 7)},
    'stages': [{'stage_id': f'SH{i+1:02}', 'title': blocks[t]['text'], 'card': work.get('stage_cards', {}).get(f'SH{i+1:02}', blocks[c]['text']), 'scene_time': scene_time(blocks[c]['text']), 'source_ref': {**source(t, c), 'wording_revision_id': work['revision_id']}, 'units': pair}
               for i, (t, c, pair) in enumerate(zip([11, 40, 66, 93, 116], [13, 42, 68, 95, 118], units))] + [v2_stage(spec) for spec in v2['stages']],
    'survey_revision_id': revisions['survey_revision']['revision_id'],
    'survey_pages': revisions['survey_revision']['survey_pages'],
    'ratings': revisions['survey_revision']['ratings'],
    'interview_prompts': paragraphs(154, 155, 156),
    # V2取消组间休息（不再输出break_ms等键），改为U2内被试自主休息一次。
    'in_unit_rest': {k: v for k, v in rest.items() if k not in {'revision_id', 'approval'}},
    'rest_revision_id': rest['revision_id'],
    'message_duration_ms': revisions['message_presentation']['fixed_duration_ms'],
    'completion_text': v2['completion_text'],
}
assert [s['stage_id'] for s in data['stages']] == [f'SH{i:02}' for i in range(1, 8)] and all(len(s['units']) == 2 for s in data['stages'])
# 定稿修订最后应用：完整替换Unit，删除的字段、expected和附件不会从旧版本残留。
pilot = revisions.get('pilot_unit_revision')
if pilot:
    replacements = {u['unit_id']: u for u in pilot['units']}
    assert len(replacements) == len(pilot['units']) == 8
    assert set(replacements) == set(pilot['replace_unit_ids']) == {
        'SH02_U1', 'SH04_U1', 'SH04_U2', 'SH05_U1', 'SH05_U2', 'SH06_U1', 'SH07_U1', 'SH07_U2'}
    existing_ids = {u['unit_id'] for s in data['stages'] for u in s['units']}
    assert set(replacements).isdisjoint(pilot['unchanged_unit_ids'])
    assert set(replacements) | set(pilot['unchanged_unit_ids']) == existing_ids
    for stage in data['stages']:
        stage['units'] = [replacements.get(u['unit_id'], u) for u in stage['units']]
    data['content_version'] = pilot['content_version']
    data['pilot_unit_revision_id'] = pilot['revision_id']


def find_table(unit, table_id):
    tables = {t['id']: t for t in (unit.get('tables') or []) + ((unit.get('reveal') or {}).get('tables') or [])}
    return tables[table_id]


def apply_plain_language(data, plain):
    """大白话修订：只替换被试可见文字。字段ID、选项取值、评分、表格数值只能经由断言过的旧值→新值单元格改动。"""
    assert data['content_version'] == plain['base_content_version'], data['content_version']
    all_units = {u['unit_id']: u for s in data['stages'] for u in s['units']}
    assert set(plain['units']) == set(all_units) and len(all_units) == 14
    assert set(plain['stage_cards']) == {s['stage_id'] for s in data['stages']}
    data['intro']['paragraphs'] = plain['intro_paragraphs']
    data['completion_text'] = plain['completion_text']
    for stage in data['stages']:
        stage['card'] = plain['stage_cards'][stage['stage_id']]
    for unit_id, patch in plain['units'].items():
        unit = all_units[unit_id]
        unit['title'] = patch['title']
        unit['paragraphs'] = patch['paragraphs']
        if 'reveal_paragraphs' in patch:
            unit['reveal']['paragraphs'] = patch['reveal_paragraphs']
        fields = {f['id']: f for f in unit['fields']}
        assert set(patch.get('field_labels', {})) <= set(fields), unit_id
        for field_id, label in patch.get('field_labels', {}).items():
            fields[field_id]['label'] = label
        for table_id, change in patch.get('tables', {}).items():
            table = find_table(unit, table_id)
            if 'caption' in change:
                table['caption'] = change['caption']
            if 'columns' in change:
                assert len(change['columns']) == len(table['columns']), table_id
                table['columns'] = change['columns']
            for row, column, before, after in change.get('cells', []):
                assert table['rows'][row][column] == before, (table_id, row, column, table['rows'][row][column])
                table['rows'][row][column] = after
    comprehension = data['survey_pages']['comprehension']
    survey = plain['survey_comprehension']
    assert comprehension['paragraphs'] == survey['paragraphs_before'] and comprehension['notice_field']['label'] == survey['notice_label_before']
    comprehension['paragraphs'] = survey['paragraphs']
    comprehension['notice_field']['label'] = survey['notice_label']
    data['content_version'] = plain['content_version']
    data['plain_language_revision_id'] = plain['revision_id']


plain = revisions.get('plain_language_revision')
if plain:
    apply_plain_language(data, plain)
(ROOT / 'content/tasks.json').write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')


def build_stimuli(uncertain_text):
    """眼镜消息与理解题：原工作簿前10条＋V2新增4条，再应用大白话修订；不确定项统一为程序文案，correct_option不变。"""
    workbook = json.loads((ROOT / 'content/source/stimulus-workbook.json').read_text(encoding='utf-8'))
    cells = next(s for s in workbook['sheets'] if s['name'] == '文案呈现与问答表')['cells']
    stimuli, stage = [], None
    for row in range(2, 12):
        def cell(col):
            return cells.get(f'{col}{row}', {}).get('value')
        stage = cell('A') or stage
        options = [{'id': line[0], 'text': uncertain_text if line[0] == 'C' else line[1:].strip()} for line in cell('H').splitlines() if line.strip()]
        stimuli.append({'stage_id': stage, 'message_id': cell('B'), 'text': cell('C'), 'duration_ms': 11000, 'question': cell('G'), 'options': options,
                        'correct_option': cell('I')[0], 'source_answer': cell('I'),
                        'source_ref': {'file': '刺激材料的属性判断.xlsx', 'sheet': '文案呈现与问答表', 'range': f'A{row}:I{row}'}})
    stimuli += [json.loads(json.dumps(s)) for s in revisions['v2_stimuli']['stimuli']]
    version = revisions['v2_stimuli']['content_version']
    if plain:
        assert version == plain['base_stimulus_content_version'], version
        by_id = {s['message_id']: s for s in stimuli}
        assert set(plain['stimuli']) <= set(by_id)
        for message_id, patch in plain['stimuli'].items():
            stimulus = by_id[message_id]
            stimulus.update({k: patch[k] for k in ('text', 'question') if k in patch})
            for option_id, text in patch.get('options', {}).items():
                option = next(o for o in stimulus['options'] if o['id'] == option_id)
                assert option_id in 'AB' and option['text'] != uncertain_text
                option['text'] = text
            correct = next(o for o in stimulus['options'] if o['id'] == stimulus['correct_option'])
            stimulus['source_answer'] = f"{stimulus['correct_option']} {correct['text']}"
        version = plain['stimulus_content_version']
    return {'content_version': version, 'stimuli': stimuli}


stimuli = build_stimuli(data['survey_pages']['comprehension']['uncertain_option_text'])
(ROOT / 'content/stimuli.json').write_text(json.dumps(stimuli, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')
print('已生成7组14单元、22张文本表格；最后应用8个单元的定稿完整替换和大白话文字修订，其余单元及实验配置保留；已生成14条眼镜消息。')
