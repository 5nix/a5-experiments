"""根据《执行单：f5-sl-pilot》（docs/执行单-f5-sl-pilot-2026-10-31.md）生成 content/tasks.json 与 content/stimuli.json。

题目、答案、说明卡、消息与理解题全部写在本脚本中，修改后重新运行即可；已有会话保留创建时的快照。
用法：python scripts/build_task_content.py
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONTENT_VERSION = 'sl-2026-10-31-v1'
STIMULUS_VERSION = 'sl-presentation-2026-10-31-v1'
REVISION_ID = 'a5-sl-pilot-sheet-2026-10-31'
SOURCE = {'file': 'docs/执行单-f5-sl-pilot-2026-10-31.md', 'revision_id': REVISION_ID}
UNCERTAIN = '不记得或不确定'

INTRO = {
    'title': '情景导入',
    'paragraphs': [
        '你是新品体验活动的筹备人员。活动在2026年11月20日（周五）14:00—17:00举行，地点是创新中心一层体验厅。',
        '接下来你要完成7个工作任务。每个任务分两个单元：先完成并提交第一单元，再根据第二单元的新资料继续完成。',
    ],
}
COMPLETION = '7个任务已经全部完成。请等待实验员进行访谈。'

SCRATCHPAD = {'label': '草稿本', 'placeholder': '在这里记录你的思考...', 'max_length': 20000}

# 以下沿用SH（理解题页、量表、访谈提示、休息文字），按执行单第一节“沿用SH，不另做改动”。
SURVEY_PAGES = {
    'comprehension': {
        'title': '信息识读理解题',
        'paragraphs': ['请根据刚才这组任务中的实际情况作答。', '第1题问你是否注意到眼镜上的消息，第2题问消息的内容。', '不记得或不确定消息内容时，选“不记得或不确定”。'],
        'notice_field': {'id': 'message_notice', 'label': '第1题：刚才这组任务中（包括休息时），你注意到眼镜上的消息了吗？', 'type': 'single', 'required': True,
                         'options': [{'value': 'not_noticed', 'label': '没有注意到任何消息'}, {'value': 'partially_read', 'label': '注意到了消息，但没有完整读到消息内容'}, {'value': 'fully_read', 'label': '完整读到了消息内容'}]},
        'uncertain_option_text': UNCERTAIN,
    },
    'ratings': {'title': '信息体验评价量表', 'paragraphs': ['请回想刚才第一次注意到眼镜消息时的情况，以及它对你完成任务的影响，按实际感受回答。'], 'skip_if_not_noticed': True},
}
AGREE = ('完全不同意', '完全同意')
RATINGS = [
    {'id': 'timing', 'label': '结合你当时正在做的事，你觉得这条消息出现的时机合适吗？', 'min': 1, 'max': 7, 'min_label': '非常不合适', 'max_label': '非常合适'},
    {'id': 'attention_distraction', 'label': '这条消息分散了我做任务时的注意力。', 'min': 1, 'max': 7, 'min_label': AGREE[0], 'max_label': AGREE[1]},
    {'id': 'thought_disruption', 'label': '这条消息扰乱了我当时的思路。', 'min': 1, 'max': 7, 'min_label': AGREE[0], 'max_label': AGREE[1]},
    {'id': 'task_interference', 'label': '这条消息妨碍了我继续完成任务。', 'min': 1, 'max': 7, 'min_label': AGREE[0], 'max_label': AGREE[1]},
    {'id': 'perceived_disturbance', 'label': '这条消息让我感到被打扰。', 'min': 1, 'max': 7, 'min_label': AGREE[0], 'max_label': AGREE[1]},
]
INTERVIEW_PROMPTS = ['刚才哪条消息让你印象最深？它出现时你正在做什么？', '你当时怎么处理这条消息？看完后继续做任务是否顺利？', '如果由你决定，这条消息在哪个步骤出现更合适？为什么？']

REST_BUTTON = '休息'
REST_INSTRUCTION = '第二单元做题过程中，在你觉得需要的时候休息一次，不要刚开始就休息，也不要在准备提交时休息。'
IN_UNIT_REST = {
    'duration_ms': 30000,
    'window_min_ms': 10000,          # SL：U2呈现后10秒才允许休息
    'window_min_ms_by_stage': {},
    't2_delay_ms': 5000,             # 休息页可见后5秒送达T2
    'button_label': REST_BUTTON,
    'early_click_text': '请先做一部分再休息',
    'already_rested_text': '本单元已经休息过了',
    'rest_title': '休息一下',
    'rest_paragraphs': ['请放松一下，暂时不用看题。时间到后会自动回到任务，已填写的答案和草稿都会保留。'],
    'show_countdown': True,
    'reminder_text': '别忘了在本单元中休息一次。',
    'reminder_display_ms': 5000,
    'tutorial_duration_ms': 5000,
    'instruction': REST_INSTRUCTION,
    'practice_window_min_ms': 5000,  # 练习单元2：窗口下限5秒、休息5秒
    'practice_duration_ms': 5000,
}
T0_TRIGGER = {'type': 'answers_filled', 'min_answers': 3, 'delay_ms': 2000}


def table(table_id, columns, rows):
    return {'id': table_id, 'caption': '', 'columns': columns, 'rows': [[str(c) for c in row] for row in rows], 'source_ref': SOURCE}


def integer_fields(rows, unit, prefix='i'):
    """作答项标签为“事项名称（单位）”，顺序与表格行一致；unit为空时标签即为行名（名称已含单位）。"""
    return [{'id': f'{prefix}{n}', 'label': f'{row[0]}（{unit}）' if unit else row[0], 'type': 'integer', 'required': True} for n, row in enumerate(rows, 1)]


def single_fields(rows):
    options = [{'value': '正确', 'label': '正确'}, {'value': '错误', 'label': '错误'}]
    return [{'id': f'i{n}', 'label': row[0], 'type': 'single', 'required': True, 'options': options} for n, row in enumerate(rows, 1)]


def unit(unit_id, title, paragraphs, columns, rows, fields, answers, table_no):
    assert len(rows) == len(fields) == len(answers), unit_id
    return {'unit_id': unit_id, 'title': title, 'paragraphs': paragraphs, 'tables': [table(f'table-{table_no:02}', columns, rows)], 'assets': [], 'fields': fields,
            'scoring': {'type': 'items', 'expected': {f['id']: a for f, a in zip(fields, answers)}, 'source_ref': SOURCE}, 'source_ref': SOURCE, 'scratchpad': dict(SCRATCHPAD)}


def calc(unit_id, title, paragraphs, columns, rows, unit_name, answers, table_no):
    return unit(unit_id, title, paragraphs, columns, rows, integer_fields(rows, unit_name), answers, table_no)


def check(unit_id, title, paragraphs, columns, rows, answers, table_no):
    return unit(unit_id, title, paragraphs, columns, rows, single_fields(rows), answers, table_no)


TIME_COLS = ['工作事项', '开始时间', '结束时间']
PAGES_COLS = ['资料名称', '每份页数（页）', '印刷份数（份）']
BATCH_COLS = ['物料名称', '第一批数量', '第二批数量']
PLAN_COLS = ['工作事项', '计划用时（分钟）', '提前完成（分钟）']
CHECK_COLS = ['工作事项', '开始时间', '用时（分钟）', '登记的结束时间']
BAG_COLS = ['资料名称', '总份数（份）', '每袋份数（份）']
CONVERT_COLS = ['工作事项', '记录的用时']

stages = []
n = 0


def tno():
    global n
    n += 1
    return n


stages.append({'stage_id': 'SL01', 'title': 'SL01任务：计算工作用时', 'scene_time': {'date': '11月18日 周三', 'time': '10:00'},
               'card': '你正在统计各项工作用了多少分钟。另外，今天中午要领取预约的工作餐，领取时间和地点还没通知。',
               'units': [
                   calc('SL01_U1', '第一单元：场地准备工作', ['下表是各项工作的开始时间和结束时间。', '算出每项工作用了多少分钟：用时 = 结束时间 − 开始时间。'], TIME_COLS,
                        [('检查场地', '9:10', '9:25'), ('检查展台', '9:20', '9:45'), ('检查电源', '9:05', '9:25'), ('摆放指示牌', '10:15', '10:25'),
                         ('调试灯光', '10:10', '10:40'), ('整理接待台', '10:20', '10:35'), ('清洁展品', '11:15', '11:35'), ('摆放桌牌', '11:20', '11:30')],
                        '分钟', [15, 25, 20, 10, 30, 15, 20, 10], tno()),
                   calc('SL01_U2', '第二单元：接待准备工作', ['继续计算下表中每项工作用了多少分钟：用时 = 结束时间 − 开始时间。'], TIME_COLS,
                        [('布置签到台', '9:15', '9:35'), ('检查资料袋', '9:10', '9:20'), ('排练接待流程', '9:20', '9:45'), ('布置寄存区', '10:05', '10:35'),
                         ('准备饮水用品', '10:10', '10:25'), ('检查服务台', '10:25', '10:45'), ('检查引导路线', '11:10', '11:40'), ('清点接待用品', '11:20', '11:45')],
                        '分钟', [20, 10, 25, 30, 15, 20, 30, 25], tno())]})

stages.append({'stage_id': 'SL02', 'title': 'SL02任务：计算资料页数', 'scene_time': {'date': '11月18日 周三', 'time': '15:00'},
               'card': '你正在计算活动资料要印多少页。另外，今天16:00要到二楼前台领取工作人员胸牌。明天去活动现场彩排时，需要带上电脑。',
               'units': [
                   calc('SL02_U1', '第一单元：参与者资料', ['算出每种资料一共要印多少页：总页数 = 每份页数 × 印刷份数。'], PAGES_COLS,
                        [('体验流程说明', 2, 3), ('参与者须知', 3, 4), ('设备使用指南', 4, 2), ('安全提示', 2, 5), ('签到说明', 3, 3), ('现场服务指南', 4, 5), ('场地示意说明', 2, 4), ('体验记录表', 3, 5)],
                        '页', [6, 12, 8, 10, 9, 20, 8, 15], tno()),
                   calc('SL02_U2', '第二单元：工作人员资料', ['继续计算下表中每种资料的总页数：总页数 = 每份页数 × 印刷份数。'], PAGES_COLS,
                        [('工作人员须知', 3, 3), ('接待流程说明', 2, 4), ('场地检查清单', 5, 2), ('设备检查说明', 3, 5), ('物料准备说明', 4, 3), ('签到操作说明', 2, 5), ('寄存服务说明', 3, 4), ('现场引导说明', 2, 3)],
                        '页', [9, 8, 10, 15, 12, 10, 12, 6], tno())]})

stages.append({'stage_id': 'SL03', 'title': 'SL03任务：统计物料总数', 'scene_time': {'date': '11月19日 周四', 'time': '10:00'},
               'card': '你正在统计物料的总数。另外，今天下班前要寄回眼镜样机。样机和配件已经打包好，还没安排寄送。',
               'units': [
                   calc('SL03_U1', '第一单元：接待物料', ['每种物料分两批到货。', '算出每种物料的总数：总数 = 第一批数量 + 第二批数量。'], BATCH_COLS,
                        [('工作人员胸牌（个）', 12, 15), ('参与者挂绳（条）', 23, 14), ('签字笔（支）', 16, 12), ('资料袋（个）', 21, 18),
                         ('寄存号码牌（个）', 14, 24), ('签到夹板（个）', 22, 13), ('宣传折页（张）', 15, 14), ('矿泉水（瓶）', 24, 12)],
                        None, [27, 37, 28, 39, 38, 35, 29, 36], tno()),
                   calc('SL03_U2', '第二单元：体验区物料', ['继续计算下表中每种物料的总数：总数 = 第一批数量 + 第二批数量。'], BATCH_COLS,
                        [('体验记录表（份）', 22, 14), ('设备清洁布（块）', 13, 15), ('消毒湿巾（包）', 24, 13), ('展台提示卡（张）', 12, 22),
                         ('备用电池（节）', 16, 11), ('设备收纳袋（个）', 21, 12), ('反馈卡（张）', 14, 15), ('一次性耳罩（对）', 23, 12)],
                        None, [36, 28, 37, 34, 27, 33, 29, 35], tno())]})

stages.append({'stage_id': 'SL04', 'title': 'SL04任务：计算实际用时', 'scene_time': {'date': '11月19日 周四', 'time': '14:00'},
               'card': '你正在计算准备工作的实际用时。另外，明天12:30要到创新中心参加现场准备，还没安排交通。',
               'units': [
                   calc('SL04_U1', '第一单元：场地准备记录', ['下表中的工作都比计划提前完成。', '算出每项工作的实际用时：实际用时 = 计划用时 − 提前完成的分钟数。'], PLAN_COLS,
                        [('组装展台', 28, 13), ('摆放座椅', 37, 12), ('检查电源', 46, 24), ('安装指示牌', 39, 16), ('整理接待台', 35, 14), ('检查灯光', 48, 22), ('固定展板', 27, 15), ('清理通道', 49, 21)],
                        '分钟', [15, 25, 22, 23, 21, 26, 12, 28], tno()),
                   calc('SL04_U2', '第二单元：资料与设备准备记录', ['继续计算下表中每项工作的实际用时：实际用时 = 计划用时 − 提前完成的分钟数。'], PLAN_COLS,
                        [('资料装袋', 38, 14), ('胸牌整理', 29, 17), ('设备充电检查', 47, 22), ('音响连接', 36, 15), ('展品清洁', 49, 21), ('签到用品整理', 27, 12), ('线缆整理', 34, 11), ('网络测试', 45, 23)],
                        '分钟', [24, 12, 25, 21, 28, 15, 23, 22], tno())]})

stages.append({'stage_id': 'SL05', 'title': 'SL05任务：核对结束时间', 'scene_time': {'date': '11月19日 周四', 'time': '15:30'},
               'card': '你正在核对各项工作的结束时间。另外，明天活动开始前要拍工作人员合影，具体安排由场务组通知。',
               'units': [
                   check('SL05_U1', '第一单元：工作时间核对', ['下表登记了每项工作的开始时间、用时和结束时间。', '检查登记的结束时间对不对：开始时间 + 用时 = 结束时间。', '对就选“正确”，不对就选“错误”。'], CHECK_COLS,
                         [('场地巡查', '9:10', 15, '9:25'), ('展台检查', '9:20', 20, '9:45'), ('设备清洁', '9:05', 25, '9:30'), ('灯光调试', '10:15', 10, '10:20'),
                          ('指示牌检查', '10:10', 30, '10:40'), ('音响测试', '10:20', 15, '10:45'), ('展品摆放', '11:05', 20, '11:25'), ('入口布置', '11:10', 25, '11:35')],
                         ['正确', '错误', '正确', '错误', '正确', '错误', '正确', '正确'], tno()),
                   check('SL05_U2', '第二单元：接待与服务记录', ['继续检查下表中登记的结束时间对不对：开始时间 + 用时 = 结束时间。', '对就选“正确”，不对就选“错误”。'], CHECK_COLS,
                         [('签到台整理', '9:15', 20, '9:40'), ('资料袋清点', '9:10', 30, '9:40'), ('服务台布置', '9:20', 15, '9:30'), ('寄存区检查', '10:05', 25, '10:30'),
                          ('饮水用品准备', '10:15', 10, '10:25'), ('引导路线检查', '10:10', 20, '10:40'), ('接待用品清点', '11:20', 25, '11:35'), ('工作人员说明', '11:05', 15, '11:20')],
                         ['错误', '正确', '错误', '正确', '正确', '错误', '错误', '正确'], tno())]})

stages.append({'stage_id': 'SL06', 'title': 'SL06任务：计算分装袋数', 'scene_time': {'date': '11月20日 周五', 'time': '10:30'},
               'card': '你正在计算资料要分装成多少袋。另外，今天要完成资料袋分装，并带到活动现场。',
               'units': [
                   calc('SL06_U1', '第一单元：参与者资料分装', ['每种资料按固定份数装袋。', '算出每种资料要装多少袋：袋数 = 总份数 ÷ 每袋份数。'], BAG_COLS,
                        [('体验流程说明', 12, 3), ('参与者须知', 10, 2), ('设备使用指南', 8, 4), ('安全提示', 15, 5), ('签到说明', 6, 2), ('现场服务指南', 20, 4), ('场地示意说明', 9, 3), ('体验记录表', 16, 4)],
                        '袋', [4, 5, 2, 3, 3, 5, 3, 4], tno()),
                   calc('SL06_U2', '第二单元：工作人员资料分装', ['继续计算下表中每种资料要装多少袋：袋数 = 总份数 ÷ 每袋份数。'], BAG_COLS,
                        [('工作人员须知', 15, 5), ('接待流程说明', 12, 3), ('场地检查清单', 10, 5), ('设备检查说明', 20, 4), ('物料准备说明', 6, 2), ('签到操作说明', 12, 4), ('寄存服务说明', 10, 2), ('现场引导说明', 9, 3)],
                        '袋', [3, 4, 2, 5, 3, 3, 5, 3], tno())]})

stages.append({'stage_id': 'SL07', 'title': 'SL07任务：换算工作时长', 'scene_time': {'date': '11月20日 周五', 'time': '12:00'},
               'card': '你正在把工作时长换算成分钟。另外，12:45要到创新中心参加现场准备，还没确定怎么过去。',
               'units': [
                   calc('SL07_U1', '第一单元：场地准备时长', ['把下表中每条记录的用时换算成分钟。', '1小时 = 60分钟，2小时 = 120分钟。'], CONVERT_COLS,
                        [('组装展台', '1小时10分钟'), ('安装展板', '2小时'), ('调试灯光', '1小时20分钟'), ('整理接待区', '1小时5分钟'),
                         ('布置场地', '2小时10分钟'), ('安装引导标识', '1小时30分钟'), ('陈列展品', '2小时5分钟'), ('检查通道', '1小时15分钟')],
                        '分钟', [70, 120, 80, 65, 130, 90, 125, 75], tno()),
                   calc('SL07_U2', '第二单元：设备准备时长', ['继续把下表中每条记录的用时换算成分钟。', '1小时 = 60分钟，2小时 = 120分钟。'], CONVERT_COLS,
                        [('安装体验设备', '2小时5分钟'), ('连接音响设备', '1小时25分钟'), ('设置签到设备', '1小时10分钟'), ('设备整体测试', '2小时20分钟'),
                         ('检查备用设备', '1小时5分钟'), ('展示内容导入', '2小时10分钟'), ('整理充电设备', '1小时20分钟'), ('网络连接测试', '2小时')],
                        '分钟', [125, 85, 70, 140, 65, 130, 80, 120], tno())]})

# 练习单元：东侧、西侧书架。不判对错，不呈现眼镜消息；练习单元2须完成一次练习休息后才能提交。
SHELF_COLS = ['书架', '层数', '每层本数（本）']
practice_units = [
    {'unit_id': 'PRACTICE_U1', 'title': '练习单元1：东侧书架',
     'paragraphs': ['你正在图书室登记书的数量。下表是每个书架的层数和每层本数。', '算出每个书架一共有多少本书：本数 = 层数 × 每层本数。'],
     'tables': [table('practice-table-01', SHELF_COLS, [('A', 2, 3), ('B', 3, 4), ('C', 4, 2), ('D', 2, 5)])], 'assets': [],
     'fields': [{'id': k, 'label': f'{k}书架（本）', 'type': 'integer', 'required': True} for k in 'ABCD'],
     'scoring': {'type': 'items', 'expected': {'A': 6, 'B': 12, 'C': 8, 'D': 10}, 'source_ref': SOURCE}, 'source_ref': SOURCE, 'scratchpad': dict(SCRATCHPAD)},
    {'unit_id': 'PRACTICE_U2', 'title': '练习单元2：西侧书架',
     'paragraphs': ['继续登记西侧书架。本数 = 层数 × 每层本数。', '1. 先填写F、G两个书架。', f'2. 点击右上角“{REST_BUTTON}”按钮休息一次。练习中的休息只有5秒。', '3. 回来后填写H、I两个书架，再提交。',
                    REST_INSTRUCTION.replace('第二单元做题过程中', '正式任务中，第二单元做题过程中', 1), '点击“休息”后如果提示“请先做一部分再休息”，稍等几秒再点。'],
     'tables': [table('practice-table-02', SHELF_COLS, [('F', 3, 2), ('G', 2, 4), ('H', 3, 5), ('I', 4, 3)])], 'assets': [],
     'fields': [{'id': k, 'label': f'{k}书架（本）', 'type': 'integer', 'required': True} for k in 'FGHI'],
     'scoring': {'type': 'items', 'expected': {'F': 6, 'G': 8, 'H': 15, 'I': 12}, 'source_ref': SOURCE}, 'source_ref': SOURCE, 'scratchpad': dict(SCRATCHPAD)},
]

tasks = {
    'schema_version': '1.3', 'content_version': CONTENT_VERSION, 'revision_id': REVISION_ID,
    'intro': INTRO, 'stages': stages,
    'survey_revision_id': 'sl-same-as-sh-surveys-2026-10-31', 'survey_pages': SURVEY_PAGES, 'ratings': RATINGS, 'interview_prompts': INTERVIEW_PROMPTS,
    'in_unit_rest': IN_UNIT_REST, 'rest_revision_id': 'sl-u2-rest-window-10s-2026-10-31',
    't0_trigger': T0_TRIGGER, 'tutorial_notice_after_practice': True,
    'message_duration_ms': 11000, 'completion_text': COMPLETION,
    'practice': {'revision_id': REVISION_ID, 'units': practice_units}, 'practice_revision_id': REVISION_ID,
}

# 眼镜消息与理解题：C项均为“不记得或不确定”。（编号, 正文, 题干, A, B, 正确）
ASK = '眼镜提出可以帮你做什么？'
MESSAGES = [
    ('N01', '请于今天12:00到一楼服务台领取工作餐。', '工作餐在哪里领取？', '一楼服务台', '二楼服务台', 'A'),
    ('A01', '今天中午要领工作餐，可以帮你设置取餐提醒。', ASK, '设置取餐提醒', '查询取餐地点', 'A'),
    ('N02', '领取胸牌的地点改到一楼前台，时间不变。', '胸牌改到哪里领取？', '三楼前台', '一楼前台', 'B'),
    ('A02', '明天彩排要带电脑，可以帮你记到待办里。', ASK, '设置充电提醒', '记到待办里', 'B'),
    ('N03', '眼镜样机的寄回截止时间提前到16:00。', '样机寄回的截止时间提前到几点？', '16:00', '15:00', 'A'),
    ('A03', '今天要寄回样机，可以帮你预约快递上门取件。', ASK, '预约快递上门取件', '设置寄件时间提醒', 'A'),
    ('N04', '明天现场准备的到场时间推迟到12:45。', '明天的到场时间推迟到几点？', '13:00', '12:45', 'B'),
    ('A04', '明天要去创新中心，可以帮你预约出租车。', ASK, '查询公交路线', '预约出租车', 'B'),
    ('N05', '工作人员合影的安排已发到你的邮箱。', '合影安排发到了哪里？', '你的邮箱', '项目群', 'A'),
    ('A05', '明天要拍工作人员合影，可以帮你加日程提醒。', ASK, '加日程提醒', '整理合影名单', 'A'),
    ('N06', '资料分装请在12:00前完成，出发时带上。', '资料分装要在几点前完成？', '11:30', '12:00', 'B'),
    ('A06', '资料袋要带到活动现场，可以在出门前提醒你。', ASK, '预约搬运推车', '出门前提醒带上', 'B'),
    ('N07', '请在12:15前出发去创新中心集合。', '最晚几点出发？', '12:15', '12:30', 'A'),
    ('A07', '12:45到创新中心，可以帮你规划路线。', ASK, '查看实时路况', '规划路线', 'B'),
]
stimuli = []
for message_id, text, question, a, b, correct in MESSAGES:
    options = [{'id': 'A', 'text': a}, {'id': 'B', 'text': b}, {'id': 'C', 'text': UNCERTAIN}]
    stimuli.append({'stage_id': f'SL{message_id[1:]}', 'message_id': message_id, 'text': text, 'duration_ms': 11000, 'question': question, 'options': options,
                    'correct_option': correct, 'source_answer': f'{correct} {a if correct == "A" else b}', 'source_ref': SOURCE})

(ROOT / 'content/tasks.json').write_text(json.dumps(tasks, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
(ROOT / 'content/stimuli.json').write_text(json.dumps({'content_version': STIMULUS_VERSION, 'stimuli': stimuli}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(f'tasks.json：{len(stages)}组{sum(len(s["units"]) for s in stages)}单元；stimuli.json：{len(stimuli)}条消息')
