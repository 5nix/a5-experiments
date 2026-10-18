"""从Word原文与内嵌Excel生成文本表格，应用经用户批准的独立文案修订。"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
raw = json.loads((ROOT / 'content/source/task-document.json').read_text())
blocks = {b['block_index']: b for b in raw['blocks']}
revisions = json.loads((ROOT / 'content/revisions.json').read_text())
embedded = json.loads((ROOT / 'content/source/embedded-workbooks.json').read_text())
workbooks = {int(re.search(r'Worksheet(\d+)', w['source_member']).group(1)): w for w in embedded['workbooks']}


def paragraphs(*indexes):
    return [revisions['paragraph_overrides'].get(str(i), blocks[i]['text']) for i in indexes]


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
    return {'id': f'table-{n:02}', 'caption': row(1)[0] if header == 2 else title,
            'columns': row(header), 'rows': [row(i) for i in range(header + 1, last_row + 1)],
            'source_ref': {'file': 'A5 SH任务pilot.docx', 'embedded_file': workbook['source_member'], 'sheet': sheet['name'], 'range': f'A{header}:{chr(64 + columns)}{last_row}', 'sha256': workbook['sha256']}}


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
    return [field('debug', '设备调试', 'time'), field('training', '讲解培训', 'time'),
            field('acceptance', '现场验收', 'time'), field('on_time', '能否在12:00前完成验收？', 'single', [('能', '能'), ('不能', '不能')])]


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
    # 日常工作语气的措辞修订：只换说法与呈现，数值、条件和作答要求不变；原句见原始提取与archive。
    value = {'unit_id': unit_id, 'title': blocks[title]['text'], 'paragraphs': work['unit_paragraphs'].get(unit_id, paragraphs(*indexes)),
             'tables': tables, 'assets': [], 'fields': fields, 'scoring': scoring,
             'source_ref': {**source(title, *indexes), 'wording_revision_id': work['revision_id']}}
    value['scratchpad'] = {'label': '草稿本', 'placeholder': work['scratchpad_placeholder'], 'max_length': 20000}
    if reveal:
        value['reveal'] = {**reveal, 'button_label': work['reveal_labels'].get(unit_id, reveal['button_label'])}
    return value


def exact(expected, answer_block):
    return {'type': 'exact', 'expected': expected, 'source_ref': source(answer_block)}


units = [
    [unit('SH01', 1, 16, [17, 19], [table(1, '方案报价表')], [choices()], exact({'plans': ['A', 'B']}, 25),
          {'button_label': '查看方案筹备日期表', 'paragraphs': [], 'tables': [table(2, '方案筹备日期表')]}),
     unit('SH01', 2, 26, [27, 30, 33], [table(3, '更新后的完整方案数据')],
          [field(v, f'{v} 最终费用（万元）', 'money') for v in 'ABCD'] + [choices()],
          exact({'A': '5.04', 'B': '4.89', 'C': '4.92', 'D': '4.88', 'plans': ['B', 'D']}, 39))],
    [unit('SH02', 1, 44, [45, 46, 48], [table(4, '工作环节与时长的对应')], schedule_fields(),
          exact({'debug': '9:45', 'training': '10:45', 'acceptance': '11:15', 'on_time': '能'}, 54),
          {'button_label': '查看人员时间安排', 'paragraphs': [], 'tables': [table(5, '人员时间安排')]}),
     unit('SH02', 2, 55, [56, 59], [table(6, '更新后的准备日程资料')], schedule_fields(),
          exact({'debug': '9:45', 'training': '11:00', 'acceptance': '11:45', 'on_time': '不能'}, 65))],
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
          [field('plan', '补充方案', 'single', plans), field('badge_surplus', '多出胸牌（张）', 'integer_or_na'), field('record_surplus', '多出体验记录表（张）', 'integer_or_na')],
          exact({'plan': 'D', 'badge_surplus': 1, 'record_surplus': 3}, 143))],
]
def scene_time(card):
    # 说明卡中的情景时间，供被试端任务栏时钟固定显示（不走动），文字取自原卡片。
    match = re.match(r'现在的时间是：(\d+月\d+日 周.) (\d{1,2}:\d{2})', card)
    assert match, card
    return {'date': match.group(1), 'time': match.group(2)}


data = {
    'schema_version': '1.1', 'content_version': 'sh-current-2026-10-19-v4', 'revision_id': revisions['revision_id'], 'wording_revision_id': work['revision_id'],
    'intro': {'title': '情景导入', 'paragraphs': paragraphs(6, 7), 'source_ref': source(6, 7)},
    'stages': [{'stage_id': f'SH{i+1:02}', 'title': blocks[t]['text'], 'card': blocks[c]['text'], 'scene_time': scene_time(blocks[c]['text']), 'source_ref': source(t, c), 'units': pair}
               for i, (t, c, pair) in enumerate(zip([11, 40, 66, 93, 116], [13, 42, 68, 95, 118], units))],
    'ratings': [{'id': id, 'label': blocks[i]['text'], 'min': 1, 'max': 7, 'source_ref': source(i)}
                for id, i in zip(['timing', 'disruption', 'effort', 'helpfulness'], range(148, 152))],
    'interview_prompts': paragraphs(154, 155, 156),
    'break_ms': 180000, 'allow_break_skip': True, 'message_duration_ms': 8500,
    'completion_text': '五组任务已完成，请等待实验员进行访谈。',
}
(ROOT / 'content/tasks.json').write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
print('已生成5组10单元、18张文本表格、已批准M1—M6修订、日常工作语气措辞、文件式附件、可跳过休息和全任务草稿本配置。')
